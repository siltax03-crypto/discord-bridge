# 음성 복제 서버 (zero-shot) — 학습 없이 참조 음성 10~30초로 그 목소리를 흉내낸다.
# 캐릭터가 보내는 🎤 음성메모를 이 서버가 만든다. 각자 자기 Modal 계정에 배포해서 쓴다.
#
# 배포 (자세한 건 modal/README.md):
#   pip install modal && modal token new
#   modal deploy modal/clone_app.py
#   → 출력된 URL(api)을 ST 확장 "🎤 음성메모 서버 URL"에 붙여넣기
#
# 목소리 추가 보호(선택): 배포 때 토큰을 주면 그 값을 아는 사람만 목소리 등록 가능.
#   CLONE_ADD_TOKEN=아무_긴_문자열 modal deploy modal/clone_app.py
#   (확장의 "목소리 추가 토큰"에 같은 값 입력. 안 쓰면 URL 아는 사람은 누구나 추가 가능)
#
# ⚠️ 비용 구조 — GPU는 "말할 때"만 켜진다:
#   웹 프론트(/warm, /add_sample, /del_sample)는 CPU 컨테이너라 거의 공짜.
#   확장이 설정창 열 때마다 목록을 조회해도 GPU는 안 깨어난다.
#   T4는 /speak 요청이 올 때만 켜지고, 유휴 3분 뒤 자동으로 꺼진다.
#
# 💰 예산 상한 (기본 $25/월):
#   GPU 컨테이너가 살아있던 시간을 볼륨에 누적 기록하고, 한도를 넘으면 /speak가 429로 거절한다.
#   Modal은 카드가 등록돼 있으면 무료 크레딧을 넘겨도 알아서 안 멈추므로 여기서 직접 끊는다.
#   봇은 음성메모 실패를 무시하고 정상 동작하므로, 초과 시 "음성메모만 조용히 멈춤".
#   한도 변경: CLONE_BUDGET_USD=10 modal deploy modal/clone_app.py   (0 = 무제한)
#
# 엔드포인트:
#   GET  /warm              — 목소리 목록 + 이번 달 사용량 (CPU)
#   POST /add_sample?name=X — 참조 음성 등록 (CPU. body=오디오 파일, 또는 JSON {name,url})
#   POST /del_sample {name} — 목소리 삭제 (CPU)
#   POST /speak?voice=X     — body=대사 텍스트 → 그 목소리의 raw PCM(24k mono s16le) (GPU)
import glob
import io
import json
import os
import time

import modal

app = modal.App("voice-clone")

# 배포 시점 환경변수를 이미지에 굽는다 → Modal 시크릿을 따로 만들 필요 없음
ADD_TOKEN = os.environ.get("CLONE_ADD_TOKEN", "")
BUDGET_USD = os.environ.get("CLONE_BUDGET_USD", "25")

T4_USD_PER_HOUR = 0.60      # 요금이 바뀌면 여기만 수정
USAGE_PATH = "/samples/_usage.json"   # *.wav만 목소리로 세므로 이 파일은 목록에 안 잡힘


def _usage_now():
    """이번 달 GPU 사용량 {month, gpu_seconds}. 달이 바뀌면 0부터."""
    month = time.strftime("%Y-%m")
    try:
        with open(USAGE_PATH) as f:
            d = json.load(f)
        if d.get("month") == month:
            return d
    except Exception:
        pass
    return {"month": month, "gpu_seconds": 0.0}


def _usd(seconds):
    return seconds / 3600.0 * T4_USD_PER_HOUR

# GPU용 무거운 이미지 (torch + chatterbox)
gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "libsndfile1")
    .pip_install("numpy<2", "torch==2.6.0", "torchaudio==2.6.0")
    .pip_install("chatterbox-tts", "fastapi[standard]", "soundfile", "scipy", "requests")
    .env({"HF_HOME": "/cache", "TORCH_HOME": "/cache"})
)

# 웹 프론트용 가벼운 이미지 (torch 없음 → 콜드스타트 몇 초, 비용 거의 0)
web_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("fastapi[standard]", "requests")
    .env({"ADD_TOKEN": ADD_TOKEN, "BUDGET_USD": BUDGET_USD})
)

samples_vol = modal.Volume.from_name("clone-samples", create_if_missing=True)  # 참조 음성
cache_vol = modal.Volume.from_name("clone-cache", create_if_missing=True)      # 모델 가중치 캐시(콜드스타트 단축)


# ─────────────────────────────────────────────────────────────
# GPU: 실제 음성 생성만 담당. /speak 요청이 있을 때만 켜진다.
# ─────────────────────────────────────────────────────────────
@app.cls(
    image=gpu_image, gpu="T4", scaledown_window=180, timeout=600,
    volumes={"/samples": samples_vol, "/cache": cache_vol},
)
class Speaker:
    @modal.enter()
    def setup(self):
        self.t0 = time.time()   # 컨테이너 수명 = 실제 과금 단위 (콜드스타트 + 생성 + 유휴)
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
        print(f"Clone 준비 완료 (다국어={self.multi}, sr={getattr(self.model, 'sr', '?')})")

    @modal.exit()
    def teardown(self):
        """컨테이너가 꺼질 때 이번 수명을 누적 기록 → 웹 프론트가 이걸 보고 예산을 끊는다."""
        dur = time.time() - self.t0
        try:
            samples_vol.reload()
            u = _usage_now()
            u["gpu_seconds"] = u.get("gpu_seconds", 0.0) + dur
            with open(USAGE_PATH, "w") as f:
                json.dump(u, f)
            samples_vol.commit()
            print(f"[Usage] 이번 컨테이너 {dur:.0f}초 → 이번 달 누적 {u['gpu_seconds']:.0f}초 (${_usd(u['gpu_seconds']):.2f})")
        except Exception as e:
            print("사용량 기록 실패:", e)

    # exaggeration↑ = 감정 과장, cfg↓ = 참조 억양에 덜 묶임(자유로운 연기). 기본값은 실측 튜닝값.
    @modal.method()
    def speak(self, text: str, voice: str = "", lang: str = "en",
              exaggeration: float = 1.2, cfg: float = 0.3) -> bytes:
        import numpy as np
        import torch

        ref = f"/samples/{voice}.wav" if voice else ""
        if voice and not os.path.exists(ref):
            try:
                samples_vol.reload()  # 방금 추가됐을 수 있음
            except Exception:
                pass
            if not os.path.exists(ref):
                raise ValueError(f"unknown voice: {voice}")

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

        arr = wav.squeeze().detach().cpu().numpy() if isinstance(wav, torch.Tensor) else np.asarray(wav).squeeze()
        sr = int(getattr(self.model, "sr", 24000))
        if sr != 24000:  # 봇 파이프라인은 24k mono 고정
            from scipy.signal import resample_poly

            arr = resample_poly(arr, 24000, sr)
        return np.clip(arr * 32767.0, -32768, 32767).astype("<i2").tobytes()


# ─────────────────────────────────────────────────────────────
# CPU: 웹 프론트. 목록/등록/삭제는 여기서 처리하고 /speak만 GPU로 넘긴다.
# ─────────────────────────────────────────────────────────────
@app.function(image=web_image, volumes={"/samples": samples_vol}, scaledown_window=60)
@modal.asgi_app()
def api():
    import re
    import subprocess

    import requests as rq
    from fastapi import FastAPI, Request, Response
    from fastapi.middleware.cors import CORSMiddleware

    web = FastAPI()
    # ST 확장(브라우저)에서 직접 호출 가능하게
    web.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    add_token = os.environ.get("ADD_TOKEN", "")
    try:
        budget = float(os.environ.get("BUDGET_USD") or 0)
    except ValueError:
        budget = 0.0

    def voices():
        try:
            samples_vol.reload()
        except Exception:
            pass
        return sorted(os.path.splitext(os.path.basename(p))[0] for p in glob.glob("/samples/*.wav"))

    def auth_ok(request: Request) -> bool:
        return not add_token or request.headers.get("x-add-token") == add_token

    # 목소리 목록 — CPU만 쓴다 (확장이 설정창 열 때마다 불러도 GPU가 안 깨어남)
    @web.get("/warm")
    def warm():
        try:
            samples_vol.reload()
        except Exception:
            pass
        u = _usage_now()
        return {
            "ok": True,
            "voices": voices(),
            "spent_usd": round(_usd(u["gpu_seconds"]), 2),
            "budget_usd": budget,
            "month": u["month"],
        }

    # 참조 음성 등록 — 업로더가 "본인 소유/권한 있음"에 동의한 것으로 간주 (c.ai와 동일한 책임 구조)
    # 두 가지 방식: JSON {name, url} 또는 ?name=X + 오디오 파일 바이너리 본문(확장의 파일 업로드)
    @web.post("/add_sample")
    async def add_sample(request: Request, name: str = ""):
        if not auth_ok(request):
            return Response(status_code=401, content=b"add token required")
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
            data = rq.get(url, timeout=300).content if url else body
            with open(raw, "wb") as f:
                f.write(data)
            # 어떤 포맷이든 24k mono wav로 정규화 (참조는 10~30초면 충분 → 30초로 컷)
            subprocess.run(
                ["ffmpeg", "-y", "-i", raw, "-t", "30", "-ar", "24000", "-ac", "1", f"/samples/{name}.wav"],
                check=True, capture_output=True,
            )
            samples_vol.commit()
        except subprocess.CalledProcessError as e:
            return Response(status_code=422, content=f"오디오 변환 실패: {e.stderr[-300:].decode(errors='ignore')}".encode())
        except Exception as e:
            return Response(status_code=500, content=f"등록 실패: {e}".encode())
        return {"ok": True, "voices": voices()}

    @web.post("/del_sample")
    async def del_sample(request: Request):
        if not auth_ok(request):
            return Response(status_code=401, content=b"add token required")
        d = await request.json()
        p = f"/samples/{str(d.get('name', '')).lower()}.wav"
        if os.path.exists(p):
            os.remove(p)
            samples_vol.commit()
        return {"ok": True, "voices": voices()}

    # 텍스트 → 그 목소리로 말하기. 여기서만 GPU가 켜진다.
    @web.post("/speak")
    async def speak(request: Request, voice: str = "", lang: str = "en",
                    exaggeration: float = 1.2, cfg: float = 0.3):
        text = (await request.body()).decode("utf-8").strip()
        if not text:
            return Response(status_code=400, content=b"text required")
        if voice and voice not in voices():
            return Response(status_code=404, content=f"unknown voice: {voice}".encode())
        # 예산 상한 — 넘으면 GPU를 아예 안 깨운다 (봇은 음성메모 실패를 무시하고 정상 동작)
        if budget > 0:
            try:
                samples_vol.reload()
            except Exception:
                pass
            spent = _usd(_usage_now()["gpu_seconds"])
            if spent >= budget:
                msg = f"이번 달 예산 초과 (${spent:.2f}/${budget:.0f}) — 음성메모 중단됨"
                print("[Budget]", msg)
                return Response(status_code=429, content=msg.encode())
        try:
            pcm = Speaker().speak.remote(text, voice, lang, exaggeration, cfg)
        except Exception as e:
            import traceback

            traceback.print_exc()
            return Response(status_code=500, content=f"생성 실패: {e}".encode())
        return Response(content=pcm, media_type="application/octet-stream")

    return web
