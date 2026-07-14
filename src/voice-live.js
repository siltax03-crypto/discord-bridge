// Gemini Live API 클라이언트 (실시간 음성↔음성)
// 오디오 IN: PCM 16kHz mono base64 / OUT: PCM 24kHz mono
// VAD는 수동(activityStart/End) — 디코가 침묵을 전송 안 하므로 서버 자동감지 대신 디코의 말시작/끝 이벤트를 쓴다.
// vertex:true면 Vertex(aiplatform) 엔드포인트 — 무료 AI Studio와 달리 대화가 구글 학습에 안 쓰임.
import WebSocket from 'ws';

class GeminiLive {
    // opts: { apiKey, model, voiceName, systemInstruction, vertex, onAudio(pcm24kBuf), onInterrupted(), onTurnComplete(),
    //         onUserText(t), onModelText(t), onError(msg), onClose() }
    constructor(opts) {
        this.o = opts;
        this.ws = null;
        this.ready = false;
        this.closed = false;
    }

    connect() {
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
                        model: this.o.vertex ? `publishers/google/models/${this.o.model}` : `models/${this.o.model}`,
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
