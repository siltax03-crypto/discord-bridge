# 음성 복제 서버 (zero-shot) — 학습 없이 참조 음성 10~30초로 그 목소리를 흉내낸다.
# 캐릭터가 보내는 🎤 음성메모를 이 서버가 만든다. 각자 자기 Modal 계정에 배포해서 쓴다.
#
# 배포 (자세한 건 modal/README.md):
#   pip install modal && modal token new
#   modal deploy modal/clone_app.py
#   → 출력된 URL을 ST 확장 "🎤 음성 복제 서버 URL"에 붙여넣기
#
# 목소리 추가 보호(선택): 배포 때 토큰을 주면 그 값을 아는 사람만 목소리 등록 가능.
#   CLONE_ADD_TOKEN=아무_긴_문자열 modal deploy modal/clone_app.py
#   (확장의 "목소리 추가 토큰"에 같은 값 입력. 안 쓰면 URL 아는 사람은 누구나 추가 가능)
#
# 엔드포인트:
#   GET  /warm              — 워밍업 + 등록된 목소리 목록
#   POST /add_sample?name=X — 참조 음성 등록 (body=오디오 파일, 또는 JSON {name,url})
#   POST /del_sample {name} — 목소리 삭제
#   POST /speak?voice=X     — body=대사 텍스트 → 그 목소리의 raw PCM(24k mono s16le)
import glob
import io
import os

import modal

app = modal.App("voice-clone")

# 배포 시점 환경변수를 이미지에 굽는다 → Modal 시크릿을 따로 만들 필요 없음
ADD_TOKEN = os.environ.get("CLONE_ADD_TOKEN", "")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "libsndfile1")
    .pip_install("numpy<2", "torch==2.6.0", "torchaudio==2.6.0")
    .pip_install("chatterbox-tts", "fastapi[standard]", "soundfile", "scipy", "requests")
    .env({"HF_HOME": "/cache", "TORCH_HOME": "/cache", "ADD_TOKEN": ADD_TOKEN})
)

samples_vol = modal.Volume.from_name("clone-samples", create_if_missing=True)  # 참조 음성
cache_vol = modal.Volume.from_name("clone-cache", create_if_missing=True)      # 모델 가중치 캐시(콜드스타트 단축)


@app.cls(
    image=image, gpu="T4", scaledown_window=420, timeout=600,
    volumes={"/samples": samples_vol, "/cache": cache_vol},
)
class CloneServer:
    @modal.enter()
    def setup(self):
        self.add_token = os.environ.get("ADD_TOKEN", "")
        self.multi = True
        try:
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS

            self.model = ChatterboxMultilingualTTS.from_pretrained(device="cuda")
        except Exception as e:  # 다국어판이 없으면 영어판으로 폴백
            print("다국어 모델 로드 실패, 영어판으로 폴백:", e)
            from chatterbox.tts import ChatterboxTTS

            self.model = ChatterboxTTS.from_pretrained(device="cuda")
            self.multi = False
        try:
            cache_vol.commit()
        except Exception:
            pass
        print(f"Clone 준비 완료 (다국어={self.multi}, sr={getattr(self.model, 'sr', '?')}) 목소리: {self._voices()}")

    def _voices(self):
        return sorted(os.path.splitext(os.path.basename(p))[0] for p in glob.glob("/samples/*.wav"))

    @modal.asgi_app()
    def api(self):
        import numpy as np
        import requests as rq
        import soundfile as sf
        import torch
        from fastapi import FastAPI, Request, Response
        from fastapi.middleware.cors import CORSMiddleware

        web = FastAPI()
        web.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

        @web.get("/warm")
        def warm():
            return {"ok": True, "voices": self._voices(), "multilingual": self.multi}

        # 참조 음성 등록 — 업로더가 "본인 소유/권한 있음"에 동의한 것으로 간주 (c.ai와 동일한 책임 구조)
        # 두 가지 방식: JSON {name, url} 또는 ?name=X + 오디오 파일 바이너리 본문(확장의 파일 업로드)
        @web.post("/add_sample")
        async def add_sample(request: Request, name: str = ""):
            if self.add_token and request.headers.get("x-add-token") != self.add_token:
                return Response(status_code=401, content=b"add token required")
            import re
            import subprocess

            body = await request.body()
            url = ""
            if not name:  # JSON 방식
                try:
                    d = __import__("json").loads(body)
                    name = str(d.get("name", ""))
                    url = str(d.get("url", "")).strip()
                except Exception:
                    return Response(status_code=400, content=b"name required")
            name = re.sub(r"[^a-z0-9_-]", "", name.lower())
            if not name or (not url and not body):
                return Response(status_code=400, content=b"name + (url or audio body) required")
            try:
                raw = "/tmp/raw_input"
                if url:
                    r = rq.get(url, timeout=300)
                    r.raise_for_status()
                    data = r.content
                else:
                    data = body
                with open(raw, "wb") as f:
                    f.write(data)
                # 어떤 포맷이든 24k mono wav로 정규화 (참조는 5~20초면 충분 → 30초로 컷)
                out = f"/samples/{name}.wav"
                subprocess.run(
                    ["ffmpeg", "-y", "-i", raw, "-t", "30", "-ar", "24000", "-ac", "1", out],
                    check=True, capture_output=True,
                )
                samples_vol.commit()
            except subprocess.CalledProcessError as e:
                return Response(status_code=422, content=f"오디오 변환 실패: {e.stderr[-300:].decode(errors='ignore')}".encode())
            except Exception as e:
                return Response(status_code=500, content=f"등록 실패: {e}".encode())
            return {"ok": True, "voices": self._voices()}

        @web.post("/del_sample")
        async def del_sample(request: Request):
            if self.add_token and request.headers.get("x-add-token") != self.add_token:
                return Response(status_code=401, content=b"add token required")
            d = await request.json()
            p = f"/samples/{str(d.get('name', '')).lower()}.wav"
            if os.path.exists(p):
                os.remove(p)
                samples_vol.commit()
            return {"ok": True, "voices": self._voices()}

        # 텍스트 → 그 목소리로 말하기 (학습 없음)
        @web.post("/speak")
        # exaggeration↑ = 감정 과장, cfg↓ = 참조 억양에 덜 묶임(자유로운 연기). 기본값은 실측 튜닝값.
        async def speak(request: Request, voice: str = "", lang: str = "en", exaggeration: float = 1.2, cfg: float = 0.3):
            text = (await request.body()).decode("utf-8").strip()
            if not text:
                return Response(status_code=400, content=b"text required")
            ref = f"/samples/{voice}.wav" if voice else ""
            if voice and not os.path.exists(ref):
                try:
                    samples_vol.reload()  # 다른 컨테이너가 방금 추가했을 수 있음
                except Exception:
                    pass
                if not os.path.exists(ref):
                    return Response(status_code=404, content=f"unknown voice: {voice}".encode())
            try:
                kw = {"audio_prompt_path": ref} if ref else {}
                if self.multi:
                    kw["language_id"] = lang
                try:
                    kw["exaggeration"] = exaggeration
                    kw["cfg_weight"] = cfg
                    wav = self.model.generate(text, **kw)
                except TypeError:  # 그 파라미터를 안 받는 버전
                    kw.pop("exaggeration", None)
                    kw.pop("cfg_weight", None)
                    wav = self.model.generate(text, **kw)
            except Exception as e:
                import traceback

                traceback.print_exc()
                return Response(status_code=500, content=f"생성 실패: {e}".encode())

            arr = wav.squeeze().detach().cpu().numpy() if isinstance(wav, torch.Tensor) else np.asarray(wav).squeeze()
            sr = int(getattr(self.model, "sr", 24000))
            if sr != 24000:  # 봇 파이프라인은 24k mono 고정
                from scipy.signal import resample_poly

                arr = resample_poly(arr, 24000, sr)
            pcm = np.clip(arr * 32767.0, -32768, 32767).astype("<i2").tobytes()
            return Response(content=pcm, media_type="application/octet-stream")

        return web
