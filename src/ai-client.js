import STReader from './st-reader.js';

let profile = null;
let config = {};

const AIClient = {
    init(cfg) {
        config = cfg;
        profile = STReader.getConnectionProfile(cfg.connectionProfile);
    },

    // 실제 생성에 쓰는, 해석된 프로필 (프리셋 등 일관성 위해 단일 출처)
    getProfile() {
        return profile;
    },

    async sendMessage(messages, options = {}) {
        const api = profile.api || '';
        const model = profile.model || '';
        const maxTokens = options.maxTokens || config.maxResponseTokens || 1000;

        // "잼민이랑 친해지기" OAuth 프록시: 모델이 antigravity-* 면 로컬 OpenAI호환 프록시로.
        // (이 표식은 그 프록시에만 있어서, 다른 사람 일반 프로필엔 영향 없음)
        if (model.startsWith('antigravity')) {
            return this._sendOAuthProxy(messages, model, maxTokens);
        }

        if (api.includes('vertex') || api.includes('google') || api.includes('makersuite') || model.includes('gemini')) {
            return this._sendGemini(messages, model, maxTokens);
        }
        if (api.includes('claude') || model.includes('claude')) {
            return this._sendClaude(messages, model, maxTokens);
        }
        if (api.includes('openai') || model.includes('gpt')) {
            return this._sendOpenAI(messages, model, maxTokens);
        }
        return this._sendOpenAI(messages, model, maxTokens);
    },

    // --- Gemini (API 키 또는 서비스 계정) ---
    async _sendGemini(messages, model, maxTokens) {
        const systemMessages = messages.filter(m => m.role === 'system');
        const chatMessages = messages.filter(m => m.role !== 'system');
        const systemInstruction = systemMessages.map(m =>
            typeof m.content === 'string' ? m.content : m.content.map(c => c.text || '').join('\n')
        ).join('\n\n');

        const contents = chatMessages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: typeof m.content === 'string'
                ? [{ text: m.content }]
                : m.content.map(c => {
                    if (c.type === 'text') return { text: c.text };
                    if (c.type === 'image_url') {
                        const match = c.image_url.url.match(/^data:(image\/[^;]+);base64,(.+)$/);
                        if (match) {
                            return { inline_data: { mime_type: match[1], data: match[2] } };
                        }
                    }
                    return { text: '' };
                }),
        }));

        // contents가 비면 Vertex가 400(at least one contents field). 최소 1개 보장.
        if (contents.length === 0) {
            contents.push({ role: 'user', parts: [{ text: '(계속)' }] });
        }

        const modelName = model || 'gemini-2.0-flash';
        const body = {
            contents,
            generationConfig: {
                maxOutputTokens: maxTokens,
                temperature: config.temperature ?? 1.0,
                topP: config.topP ?? 0.95,
                // 같은 표현 반복 억제
                frequencyPenalty: config.frequencyPenalty ?? 0.6,
                presencePenalty: config.presencePenalty ?? 0.4,
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
            ],
        };
        if (systemInstruction) {
            body.system_instruction = { parts: [{ text: systemInstruction }] };
        }

        // Vertex AI Express 엔드포인트 (API 키 인증)
        const apiKey = profile.apiKey;
        if (!apiKey) throw new Error('Vertex AI API 키가 없습니다');
        const region = profile['api-url'] || 'us-central1';
        const baseUrl = region === 'global'
            ? 'https://aiplatform.googleapis.com'
            : `https://${region}-aiplatform.googleapis.com`;
        const url = `${baseUrl}/v1/publishers/google/models/${modelName}:generateContent?key=${apiKey}`;

        // Gemini가 STOP인데 빈 텍스트를 뱉는 경우(RP/민감 컨텍스트 간헐 현상) 자동 재시도
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!resp.ok) {
                const err = await resp.text();
                throw new Error(`Gemini API 오류 (${resp.status}): ${err}`);
            }

            const data = await resp.json();
            const cand = data.candidates?.[0];
            // thinking 모델은 part가 여러 개(사고/출력)일 수 있으니 텍스트 part를 전부 합친다
            const parts = cand?.content?.parts || [];
            const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();

            if (text) {
                if (cand?.finishReason === 'MAX_TOKENS') {
                    console.warn(`[AI] 응답이 토큰 한도에서 잘림 (MAX_TOKENS, maxTokens=${maxTokens}). 응답 토큰을 더 올리세요.`);
                }
                return text;
            }

            console.warn(
                `[AI] 빈 응답 (시도 ${attempt}/${MAX_ATTEMPTS}). finishReason=${cand?.finishReason}, ` +
                `parts=${parts.length}, promptFeedback=${JSON.stringify(data.promptFeedback || {})}`,
            );
            if (attempt === 1) console.warn(`[AI] parts 덤프: ${JSON.stringify(parts).slice(0, 400)}`);
        }

        return ''; // 재시도 모두 빈 응답
    },

    // --- "잼민이랑 친해지기" 로컬 OAuth 프록시 (OpenAI 호환). API키 불필요, 프록시가 OAuth 처리 ---
    // 봇과 ST(=프록시)가 같은 서버일 때 localhost로 접근. URL은 config.oauthProxyUrl로 변경 가능.
    async _sendOAuthProxy(messages, model, maxTokens) {
        const base = (config.oauthProxyUrl || 'http://127.0.0.1:18765/v1').replace(/\/+$/, '');
        const resp = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                messages: messages.map(m => ({ role: m.role, content: m.content })),
            }),
        });
        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`OAuth 프록시 오류 (${resp.status}): ${err.slice(0, 300)}`);
        }
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || '';
    },

    // --- Claude ---
    async _sendClaude(messages, model, maxTokens) {
        const apiKey = profile.apiKey;
        if (!apiKey) throw new Error('Claude API 키가 없습니다');

        const systemMessages = messages.filter(m => m.role === 'system');
        const chatMessages = messages.filter(m => m.role !== 'system');
        const systemPrompt = systemMessages.map(m =>
            typeof m.content === 'string' ? m.content : m.content.map(c => c.text || '').join('\n')
        ).join('\n\n');

        const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: model || 'claude-sonnet-4-20250514',
                max_tokens: maxTokens,
                system: systemPrompt,
                messages: chatMessages.map(m => ({ role: m.role, content: m.content })),
            }),
        });

        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`Claude API 오류 (${resp.status}): ${err}`);
        }

        const data = await resp.json();
        return data.content?.[0]?.text || '';
    },

    // --- OpenAI ---
    async _sendOpenAI(messages, model, maxTokens) {
        const apiKey = profile.apiKey;
        if (!apiKey) throw new Error('OpenAI API 키가 없습니다');

        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: model || 'gpt-4o',
                max_tokens: maxTokens,
                messages: messages.map(m => ({ role: m.role, content: m.content })),
            }),
        });

        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`OpenAI API 오류 (${resp.status}): ${err}`);
        }

        const data = await resp.json();
        return data.choices?.[0]?.message?.content || '';
    },

    async sendMessageWithImage(messages, imageBase64, options = {}) {
        const lastUserIdx = messages.findLastIndex(m => m.role === 'user');
        if (lastUserIdx === -1) return this.sendMessage(messages, options);

        const modified = [...messages];
        const lastMsg = modified[lastUserIdx];
        const textContent = typeof lastMsg.content === 'string' ? lastMsg.content : '';

        modified[lastUserIdx] = {
            role: 'user',
            content: [
                { type: 'text', text: textContent },
                { type: 'image_url', image_url: { url: imageBase64 } },
            ],
        };

        return this.sendMessage(modified, options);
    },
};

export default AIClient;