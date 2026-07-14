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

# 데드풀 (Ryan Reynolds) RVC v2 모델 — 다른 목소리 쓰려면 이 URL만 교체
MODEL_URL = "https://huggingface.co/Cauthess/Deadpool_Marvel/resolve/main/Deadpool%20-%20Marvel%20Saga.zip"
# 봇 config.rvcToken과 동일하게 설정하면 남이 URL 알아도 못 씀 (빈값 = 인증 생략)
AUTH_TOKEN = ""

app = modal.App("rvc-voice")


def _download_model():
    import zipfile

    import requests

    os.makedirs("/model", exist_ok=True)
    r = requests.get(MODEL_URL, timeout=600)
    r.raise_for_status()
    zipfile.ZipFile(io.BytesIO(r.content)).extractall("/model")
    print("모델 파일:", glob.glob("/model/**/*.*", recursive=True))


image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install("rvc-python", "fastapi[standard]", "soundfile", "scipy", "numpy", "requests")
    .run_function(_download_model)
)


@app.cls(image=image, gpu="T4", scaledown_window=420, timeout=300)
class RVCServer:
    @modal.enter()
    def setup(self):
        from rvc_python.infer import RVCInference

        pth = sorted(glob.glob("/model/**/*.pth", recursive=True))
        idx = sorted(glob.glob("/model/**/*.index", recursive=True))
        if not pth:
            raise RuntimeError("모델 .pth를 못 찾음 — MODEL_URL zip 내용 확인")
        # rvc-python은 models_dir/모델명/파일 구조를 기대 → 심볼릭 구성
        os.makedirs("/models/voice", exist_ok=True)
        os.symlink(pth[0], "/models/voice/voice.pth")
        if idx:
            os.symlink(idx[0], "/models/voice/voice.index")
        self.rvc = RVCInference(device="cuda:0", models_dir="/models")
        self.rvc.load_model("voice")
        try:
            self.rvc.set_params(f0method="rmvpe", index_rate=0.75, protect=0.33)
        except Exception as e:  # 라이브러리 버전에 따라 파라미터명이 다를 수 있음
            print("set_params 생략:", e)
        print("RVC 준비 완료:", pth[0])

    @modal.asgi_app()
    def api(self):
        import numpy as np
        import soundfile as sf
        from fastapi import FastAPI, Request, Response
        from scipy.signal import resample_poly

        web = FastAPI()

        def _auth_ok(req: Request) -> bool:
            return not AUTH_TOKEN or req.headers.get("x-auth") == AUTH_TOKEN

        @web.get("/warm")
        def warm(request: Request):
            if not _auth_ok(request):
                return Response(status_code=401)
            return {"ok": True}

        @web.post("/convert")
        async def convert(request: Request, pitch: int = 0):
            if not _auth_ok(request):
                return Response(status_code=401)
            body = await request.body()
            if not body:
                return Response(status_code=400)
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
