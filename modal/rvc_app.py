# Modal RVC 음성 변환 서버 — 통화(Gemini Live) 목소리를 원하는 목소리로 갈아입히기
#
# 배포:  modal deploy modal/rvc_app.py
#   → 출력된 URL(…-api.modal.run)을 ST 확장 "RVC 변환 서버 URL"에 붙여넣기
# 목소리 교체: MODEL_URL만 다른 RVC 모델 zip으로 바꾸고 다시 deploy
#
# 엔드포인트:
#   GET  /warm            — 워밍업(모델 로드). 봇이 통화 시작 때 호출
#   POST /convert?pitch=0 — WAV(24k mono) 입력 → 변환된 raw PCM(24k mono s16le) 응답
import glob
import io
import os

import modal

# 기본 목소리(이미지에 미리 구움). 추가 목소리는 재배포 없이 POST /add_voice {name, url} 로 —
# 볼륨(rvc-voices)에 저장돼 영구 유지. ST 확장 "＋ 목소리" 버튼이 이걸 호출한다.
MODELS = {
    "deadpool": "https://huggingface.co/Cauthess/Deadpool_Marvel/resolve/main/Deadpool%20-%20Marvel%20Saga.zip",
}
DEFAULT_VOICE = "deadpool"
# 봇 config.rvcToken과 동일하게 설정하면 남이 URL 알아도 못 씀 (빈값 = 인증 생략)
AUTH_TOKEN = ""

app = modal.App("rvc-voice")


def _download_model():
    import zipfile

    import requests

    for name, url in MODELS.items():
        dest = f"/model/{name}"
        os.makedirs(dest, exist_ok=True)
        r = requests.get(url, timeout=600)
        r.raise_for_status()
        zipfile.ZipFile(io.BytesIO(r.content)).extractall(dest)
        print(f"모델 [{name}]:", glob.glob(f"{dest}/**/*.*", recursive=True))


image = (
    modal.Image.debian_slim(python_version="3.10")
    # build-essential/git: rvc-python 의존성(fairseq 등)이 C 확장을 소스 빌드함
    .apt_install("ffmpeg", "libsndfile1", "build-essential", "g++", "git")
    # torch를 먼저 깔아야 fairseq 빌드가 붙고, numpy 2.x는 구 라이브러리들과 충돌
    .pip_install("numpy<2", "torch==2.1.2", "torchaudio==2.1.2")
    # fastapi/soundfile/scipy는 rvc-python이 자기 버전으로 데려옴 — 따로 요구하면 버전 충돌(ResolutionImpossible)
    # omegaconf 2.0.6의 깨진 메타데이터("PyYAML >=5.1.*")를 최신 pip이 거부 → 그 시절 pip으로 설치
    .run_commands("python -m pip install 'pip==23.3.2'")
    .pip_install("rvc-python", "requests", extra_options="--use-deprecated=legacy-resolver")
    .run_function(_download_model)
)


voices_vol = modal.Volume.from_name("rvc-voices", create_if_missing=True)


@app.cls(image=image, gpu="T4", scaledown_window=420, timeout=300, volumes={"/voices": voices_vol})
class RVCServer:
    # 목소리 등록: src 폴더에서 .pth/.index를 찾아 rvc-python이 기대하는 /models/<name>/ 구조로 링크
    def _register(self, name, src):
        pth = sorted(glob.glob(f"{src}/**/*.pth", recursive=True))
        # 학습용 체크포인트(G_*/D_*)가 섞인 zip이면 추론용 모델을 우선
        infer_pth = [f for f in pth if not os.path.basename(f).startswith(("G_", "D_"))]
        pth = infer_pth or pth
        if not pth:
            print(f"⚠ [{name}] .pth 없음: {src}")
            return False
        idx = sorted(glob.glob(f"{src}/**/*.index", recursive=True))
        os.makedirs(f"/models/{name}", exist_ok=True)
        for target, ext in [(pth[0], "pth")] + ([(idx[0], "index")] if idx else []):
            link = f"/models/{name}/{name}.{ext}"
            if not os.path.lexists(link):
                os.symlink(target, link)
        if name not in self.available:
            self.available.append(name)
        return True

    def _scan_volume(self):
        for d in sorted(glob.glob("/voices/*")):
            if os.path.isdir(d):
                self._register(os.path.basename(d), d)

    @modal.enter()
    def setup(self):
        from rvc_python.infer import RVCInference

        self.available = []
        for name in MODELS:  # 이미지에 구운 기본 목소리
            self._register(name, f"/model/{name}")
        self._scan_volume()  # 볼륨(런타임 추가) 목소리
        if not self.available:
            raise RuntimeError("사용 가능한 모델이 없음")
        self.rvc = RVCInference(device="cuda:0", models_dir="/models")
        self.current = DEFAULT_VOICE if DEFAULT_VOICE in self.available else self.available[0]
        self.rvc.load_model(self.current)
        try:
            self.rvc.set_params(f0method="rmvpe", index_rate=0.75, protect=0.33)
        except Exception as e:  # 라이브러리 버전에 따라 파라미터명이 다를 수 있음
            print("set_params 생략:", e)
        print(f"RVC 준비 완료: {self.available} (기본 {self.current})")

    @modal.asgi_app()
    def api(self):
        import numpy as np
        import requests as rq
        import soundfile as sf
        from fastapi import FastAPI, Request, Response
        from fastapi.middleware.cors import CORSMiddleware
        from scipy.signal import resample_poly

        web = FastAPI()
        # ST 확장(브라우저)에서 직접 호출 가능하게
        web.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

        def _auth_ok(req: Request) -> bool:
            return not AUTH_TOKEN or req.headers.get("x-auth") == AUTH_TOKEN

        @web.get("/warm")
        def warm(request: Request):
            if not _auth_ok(request):
                return Response(status_code=401)
            return {"ok": True, "voices": self.available, "current": self.current}

        # 목소리 추가: {name, url(zip)} → 볼륨에 영구 저장 + 즉시 사용. 재배포 불필요.
        @web.post("/add_voice")
        async def add_voice(request: Request):
            if not _auth_ok(request):
                return Response(status_code=401)
            import re
            import zipfile

            data = await request.json()
            name = re.sub(r"[^a-z0-9_-]", "", str(data.get("name", "")).lower())
            url = str(data.get("url", "")).strip()
            if not name or not url:
                return Response(status_code=400, content=b"name/url required")
            dest = f"/voices/{name}"
            try:
                r = rq.get(url, timeout=600)
                r.raise_for_status()
                os.makedirs(dest, exist_ok=True)
                zipfile.ZipFile(io.BytesIO(r.content)).extractall(dest)
                voices_vol.commit()
            except Exception as e:
                return Response(status_code=500, content=f"다운로드/압축해제 실패: {e}".encode())
            if not self._register(name, dest):
                return Response(status_code=422, content=b".pth not found in zip")
            return {"ok": True, "voices": self.available}

        @web.post("/convert")
        async def convert(request: Request, pitch: int = 0, voice: str = ""):
            if not _auth_ok(request):
                return Response(status_code=401)
            body = await request.body()
            if not body:
                return Response(status_code=400)
            # 목소리 전환 (요청마다 지정 가능 — 로드된 모델 캐시로 전환 빠름)
            want = voice or DEFAULT_VOICE
            if want not in self.available:
                # 다른 컨테이너에서 추가된 목소리일 수 있음 → 볼륨 새로고침 후 재확인
                try:
                    voices_vol.reload()
                except Exception:
                    pass
                self._scan_volume()
            if want != self.current:
                if want not in self.available:
                    return Response(status_code=404, content=f"unknown voice: {want}".encode())
                try:
                    self.rvc.load_model(want)
                    self.current = want
                except Exception as e:
                    import traceback

                    traceback.print_exc()
                    return Response(status_code=500, content=f"모델 로드 실패({want}): {e}".encode())
            # 입력 WAV → 임시 파일 → RVC 변환 → 24k mono s16 raw PCM으로 응답
            in_path, out_path = "/tmp/in.wav", "/tmp/out.wav"
            with open(in_path, "wb") as f:
                f.write(body)
            try:
                if pitch:
                    try:
                        self.rvc.set_params(f0up_key=pitch)
                    except Exception:
                        pass
                self.rvc.infer_file(in_path, out_path)
            except Exception as e:
                print("변환 실패:", e)
                return Response(status_code=500, content=str(e).encode())
            data, sr = sf.read(out_path, dtype="float32")
            if data.ndim > 1:
                data = data.mean(axis=1)
            if sr != 24000:
                data = resample_poly(data, 24000, sr)
            pcm = np.clip(data * 32767.0, -32768, 32767).astype("<i2").tobytes()
            return Response(content=pcm, media_type="application/octet-stream")

        return web
