# RVC 실시간 흘려보내기 서버 — 통화용. RVC 서버의 볼륨 rvc-voices를 읽고, 토큰은 시크릿 rvc-add-token을 같이 쓴다.
# 배포:  modal deploy modal/rvc_stream_app.py
#
# 웹소켓  /ws?voice=<목소리 이름>&pitch=0&key=<토큰>
#   → 바이너리: 24kHz mono s16le PCM (아무 크기로나 보내면 됨)
#   ← 바이너리: 변환된 24kHz mono s16le PCM (0.25초 조각 단위)
#   → 텍스트 "flush": 턴 끝 — 남은 소리를 마저 변환해 보내고 ← "done"
#   → 텍스트 "reset": 끼어들기 — 쌓인 것 버림
#   ← 텍스트 "ready": 모델 준비 끝
import asyncio
import glob
import os
import time

import modal

app = modal.App("rvc-stream")



def _prefetch():
    # hubert·rmvpe를 이미지에 구워 콜드스타트마다 내려받지 않게
    import rvc_python
    from rvc_python.download_model import download_rvc_models

    download_rvc_models(os.path.dirname(os.path.abspath(rvc_python.__file__)))


image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "libsndfile1", "build-essential", "g++", "git")
    .pip_install("numpy<2", "torch==2.1.2", "torchaudio==2.1.2")
    .run_commands("python -m pip install 'pip==23.3.2'")
    .pip_install("rvc-python", "requests", extra_options="--use-deprecated=legacy-resolver")
    .run_function(_prefetch)
)

voices_vol = modal.Volume.from_name("rvc-voices")

BLOCK_MS = 250    # 조각 길이
CTX_MS = 1000     # 앞 문맥
XF_MS = 40        # 이음 크로스페이드
SEARCH_MS = 12    # 이음 위치 탐색
XPAD = 0.1        # 라이브러리 내부 패딩(초) — 문맥을 직접 주므로 짧게


@app.cls(image=image, gpu="T4", scaledown_window=300, timeout=3600, volumes={"/voices": voices_vol},
         secrets=[modal.Secret.from_name("rvc-add-token")], max_containers=1)
class RVCStream:
    @modal.enter()
    def setup(self):
        t = time.time()
        self.rvc = None
        self.current = None
        self._scan()
        print(f"준비 완료 {time.time() - t:.1f}s voices={self.voices()}")

    def voices(self):
        return self.rvc.list_models() if self.rvc else []

    # 볼륨의 목소리를 /models에 연결하고, 목소리가 있으면 모델·hubert를 올려 둔다 (없으면 그냥 빈 채로 켜져 있음)
    def _scan(self):
        import numpy as np
        from rvc_python.infer import RVCInference
        from rvc_python.modules.vc.utils import load_hubert

        for d in sorted(glob.glob("/voices/*")):
            name = os.path.basename(d)
            pth = [f for f in sorted(glob.glob(f"{d}/**/*.pth", recursive=True)) if not os.path.basename(f).startswith(("G_", "D_"))]
            if pth:
                os.makedirs(f"/models/{name}", exist_ok=True)
                link = f"/models/{name}/{name}.pth"
                if not os.path.lexists(link):
                    os.symlink(pth[0], link)
        self.rvc = RVCInference(device="cuda:0", models_dir="/models")
        self.current = None
        models = self.rvc.list_models()
        if not models:
            return
        self._load(models[0])
        vc = self.rvc.vc
        if vc.hubert_model is None:
            vc.hubert_model = load_hubert(vc.config, vc.lib_dir)
        self._infer(np.zeros(16 * (CTX_MS + BLOCK_MS), np.float32), 0)  # CUDA 워밍업 (고정 길이라 이후 스파이크 없음)

    # 목록에 없는 목소리 요청 → 다른 앱(RVC 서버)이 나중에 추가했을 수 있으니 볼륨을 새로 읽는다
    def _ensure(self, voice):
        if voice in self.voices():
            return True
        try:
            voices_vol.reload()
        except Exception:
            pass
        self._scan()
        return voice in self.voices()

    def _load(self, name):
        if name == self.current:
            return
        self.rvc.load_model(name)
        pl = self.rvc.vc.pipeline
        pl.t_pad = int(16000 * XPAD) // 160 * 160
        pl.t_pad_tgt = pl.t_pad * self.rvc.vc.tgt_sr // 16000
        pl.t_pad2 = pl.t_pad * 2
        self.current = name

    def _infer(self, x16, pitch):
        import numpy as np

        vc = self.rvc.vc
        out = vc.pipeline.pipeline(vc.hubert_model, vc.net_g, 0, x16, "", [0, 0, 0], pitch, "rmvpe", "", 0.0,
                                   vc.if_f0, 3, vc.tgt_sr, 0, 1, vc.version, 0.5, "")
        return out.astype(np.float32) / 32768.0

    @modal.asgi_app()
    def web(self):
        import numpy as np
        from fastapi import FastAPI, WebSocket, WebSocketDisconnect
        from scipy.signal import resample_poly

        api = FastAPI()
        token = os.environ.get("ADD_TOKEN", "")

        @api.get("/warm")
        def warm(key: str = ""):
            if token and key != token:
                return {"ok": False}
            return {"ok": True, "voices": self.voices(), "current": self.current}

        @api.websocket("/ws")
        async def ws(sock: WebSocket, voice: str = "", pitch: int = 0, key: str = ""):
            if token and key != token:
                await sock.close(code=4401)
                return
            await sock.accept()
            if not self._ensure(voice):
                await sock.close(code=4404)
                return
            await asyncio.to_thread(self._load, voice)
            tgt = self.rvc.vc.tgt_sr
            B24, C24 = 24 * BLOCK_MS, 24 * CTX_MS
            XF, S = 24 * XF_MS, 24 * SEARCH_MS
            fade_in = np.sin(0.5 * np.pi * np.linspace(0, 1, XF, dtype=np.float32)) ** 2
            st = {"win": np.zeros(C24 + B24, np.float32), "pend": np.zeros(0, np.float32), "prev": None}

            def block(new24):
                st["win"] = np.concatenate([st["win"][B24:], new24])
                x16 = resample_poly(st["win"], 2, 3).astype(np.float32)
                t0 = time.time()
                out = self._infer(x16, pitch)
                y = resample_poly(out, 24000 // 1000, tgt // 1000).astype(np.float32)
                need = B24 + XF + S
                tail = y[-need:] if len(y) >= need else np.concatenate([np.zeros(need - len(y), np.float32), y])
                off = 0
                if st["prev"] is not None:
                    head = tail[:XF + S]
                    num = np.convolve(head, st["prev"][::-1], "valid")
                    den = np.sqrt(np.convolve(head ** 2, np.ones(XF, np.float32), "valid") + 1e-8)
                    off = int(np.argmax(num / den))
                seg = tail[off:off + B24 + XF].copy()
                if st["prev"] is not None:
                    seg[:XF] = seg[:XF] * fade_in + st["prev"] * (1 - fade_in)
                st["prev"] = seg[B24:B24 + XF]
                st["ms"] = (time.time() - t0) * 1000
                return (np.clip(seg[:B24], -1, 1) * 32767).astype("<i2").tobytes()

            await sock.send_text("ready")
            try:
                while True:
                    msg = await sock.receive()
                    if msg.get("type") == "websocket.disconnect":
                        break
                    if msg.get("bytes"):
                        x = np.frombuffer(msg["bytes"], dtype="<i2").astype(np.float32) / 32768.0
                        st["pend"] = np.concatenate([st["pend"], x])
                        while len(st["pend"]) >= B24:
                            new, st["pend"] = st["pend"][:B24], st["pend"][B24:]
                            await sock.send_bytes(await asyncio.to_thread(block, new))
                    elif msg.get("text") == "flush":
                        if len(st["pend"]):
                            new = np.concatenate([st["pend"], np.zeros(B24 - len(st["pend"]), np.float32)])
                            st["pend"] = np.zeros(0, np.float32)
                            await sock.send_bytes(await asyncio.to_thread(block, new))
                        await sock.send_bytes(await asyncio.to_thread(block, np.zeros(B24, np.float32)))  # 이음 꼬리 밀어내기
                        await sock.send_text("done")
                    elif msg.get("text") == "reset":
                        st.update(win=np.zeros(C24 + B24, np.float32), pend=np.zeros(0, np.float32), prev=None)
                        await sock.send_text("reset-ok")
                    elif msg.get("text") == "stat":
                        await sock.send_text(f"ms={st.get('ms', 0):.0f}")
            except WebSocketDisconnect:
                pass

        return api
