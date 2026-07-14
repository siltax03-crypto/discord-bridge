// Gemini Live API 클라이언트 (실시간 음성↔음성)
// 오디오 IN: PCM 16kHz mono base64 / OUT: PCM 24kHz mono
// VAD는 수동(activityStart/End) — 디코가 침묵을 전송 안 하므로 서버 자동감지 대신 디코의 말시작/끝 이벤트를 쓴다.
// vertex:true면 Vertex(aiplatform) 엔드포인트 — 무료 AI Studio와 달리 대화가 구글 학습에 안 쓰임.
import WebSocket from 'ws';

// Vertex Live는 모델을 projects/<번호>/locations/global/... 전체 경로로 요구하는데,
// 익스프레스 키는 프로젝트 번호를 노출 안 함 → 지역 호스트에 더미 setup을 보내면
// 거절 사유에 자기 프로젝트 번호가 찍혀 나옴. 그걸 파싱해 캐시.
const vertexProjectCache = {};
function discoverVertexProject(apiKey) {
    if (vertexProjectCache[apiKey]) return Promise.resolve(vertexProjectCache[apiKey]);
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent?key=${apiKey}`);
        const t = setTimeout(() => { try { ws.close(); } catch { /* 무시 */ } reject(new Error('Vertex 프로젝트 탐지 타임아웃')); }, 10_000);
        ws.on('open', () => ws.send(JSON.stringify({ setup: { model: 'publishers/google/models/_probe_' } })));
        ws.on('close', (code, reason) => {
            clearTimeout(t);
            const m = String(reason).match(/projects\/(\d+)\//);
            if (m) { vertexProjectCache[apiKey] = m[1]; resolve(m[1]); }
            else reject(new Error(`Vertex 프로젝트 탐지 실패 (${code}): ${String(reason).slice(0, 150)}`));
        });
        ws.on('error', () => { /* close에서 처리 */ });
    });
}

class GeminiLive {
    // opts: { apiKey, model, voiceName, systemInstruction, vertex, onAudio(pcm24kBuf), onInterrupted(), onTurnComplete(),
    //         onUserText(t), onModelText(t), onError(msg), onClose() }
    constructor(opts) {
        this.o = opts;
        this.ws = null;
        this.ready = false;
        this.closed = false;
    }

    async connect() {
        // Vertex: 전체 리소스 경로 필요 (projects/<번호>/locations/global/…)
        const modelPath = this.o.vertex
            ? `projects/${await discoverVertexProject(this.o.apiKey)}/locations/global/publishers/google/models/${this.o.model}`
            : `models/${this.o.model}`;
        return new Promise((resolve, reject) => {
            const url = this.o.vertex
                ? `wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent?key=${this.o.apiKey}`
                : `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.o.apiKey}`;
            const ws = this.ws = new WebSocket(url);
            let settled = false;
            const fail = (msg) => { if (!settled) { settled = true; reject(new Error(msg)); } try { ws.close(); } catch { /* 무시 */ } };

            ws.on('open', () => {
                ws.send(JSON.stringify({
                    setup: {
                        model: modelPath,
                        generationConfig: {
                            responseModalities: ['AUDIO'],
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.o.voiceName || 'Charon' } } },
                        },
                        systemInstruction: { parts: [{ text: this.o.systemInstruction || '' }] },
                        // 갠톡 히스토리에 통화 내용을 남기기 위한 양방향 자막
                        inputAudioTranscription: {},
                        outputAudioTranscription: {},
                        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
                    },
                }));
            });

            ws.on('message', (raw) => {
                let msg;
                try { msg = JSON.parse(raw.toString()); } catch { return; }

                if (msg.setupComplete) {
                    this.ready = true;
                    if (!settled) { settled = true; resolve(); }
                    return;
                }
                const sc = msg.serverContent;
                if (!sc) return;
                if (sc.interrupted) { this.o.onInterrupted?.(); return; }
                if (sc.inputTranscription?.text) this.o.onUserText?.(sc.inputTranscription.text);
                if (sc.outputTranscription?.text) this.o.onModelText?.(sc.outputTranscription.text);
                for (const p of sc.modelTurn?.parts || []) {
                    const d = p.inlineData?.data;
                    if (d) this.o.onAudio?.(Buffer.from(d, 'base64'));
                }
                if (sc.turnComplete) this.o.onTurnComplete?.();
            });

            ws.on('close', (code, reason) => {
                const r = `${code} ${String(reason || '').slice(0, 300)}`;
                if (!settled) return fail(`Live 연결 거부: ${r}`);
                if (!this.closed) { this.closed = true; console.warn(`[Live] 연결 종료: ${r}`); this.o.onClose?.(); }
            });
            ws.on('error', (e) => {
                if (!settled) return fail(`Live 연결 실패: ${e.message}`);
                console.warn('[Live] 오류:', e.message);
                this.o.onError?.(e.message);
            });
        });
    }

    _send(obj) {
        if (this.ready && !this.closed && this.ws?.readyState === WebSocket.OPEN) {
            try { this.ws.send(JSON.stringify(obj)); } catch { /* 무시 */ }
        }
    }

    activityStart() { this._send({ realtimeInput: { activityStart: {} } }); }
    activityEnd() { this._send({ realtimeInput: { activityEnd: {} } }); }
    sendAudio(pcm16kMonoBuf) {
        this._send({ realtimeInput: { audio: { data: pcm16kMonoBuf.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
    }
    // 통화 시작 인사 유도 등 텍스트 넛지
    sendText(text) {
        this._send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
    }

    close() {
        this.closed = true;
        try { this.ws?.close(); } catch { /* 무시 */ }
    }
}

export default GeminiLive;
