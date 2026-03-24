import crypto from 'crypto';
import STReader from './st-reader.js';

let profile = null;
let config = {};
let cachedAccessToken = null;
let tokenExpiry = 0;

const AIClient = {
    init(cfg) {
        config = cfg;
        profile = STReader.getConnectionProfile(cfg.connectionProfile);
    },

    async sendMessage(messages, options = {}) {
        const api = profile.api || '';
        const model = profile.model || '';
        const maxTokens = options.maxTokens || config.maxResponseTokens || 1000;

        if (api.includes('vertex') || api.includes('google') || model.includes('gemini')) {
            return this._sendVertexAI(messages, model, maxTokens);
        }
        if (api.includes('claude') || model.includes('claude')) {
            return this._sendClaude(messages, model, maxTokens);
        }
        if (api.includes('openai') || model.includes('gpt')) {
            return this._sendOpenAI(messages, model, maxTokens);
        }
        return this._sendOpenAI(messages, model, maxTokens);
    },

    // --- Vertex AI (서비스 계정 인증) ---
    async _sendVertexAI(messages, model, maxTokens) {
        const accessToken = await this._getVertexAccessToken();

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

        const modelName = model || 'gemini-2.0-flash';
        const body = {
            contents,
            generationConfig: { maxOutputTokens: maxTokens },
        };
        if (systemInstruction) {
            body.system_instruction = { parts: [{ text: systemInstruction }] };
        }

        // 서비스 계정이 있으면 Vertex AI 엔드포인트, 없으면 AI Studio
        const serviceAccount = this._getServiceAccount();
        let url;
        if (serviceAccount) {
            const projectId = serviceAccount.project_id;
            const location = profile['api-url'] === 'global' ? 'us-central1' : (profile['api-url'] || 'us-central1');
            url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelName}:generateContent`;
        } else {
            // AI Studio 폴백
            const apiKey = profile.apiKey;
            url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
        }

        const headers = { 'Content-Type': 'application/json' };
        if (serviceAccount) {
            headers['Authorization'] = `Bearer ${accessToken}`;
        }

        const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`Vertex AI 오류 (${resp.status}): ${err}`);
        }

        const data = await resp.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    },

    // 서비스 계정 JSON 가져오기
    _getServiceAccount() {
        try {
            const secrets = STReader.getSecrets();
            const saJson = secrets.vertexai_service_account_json;
            if (!saJson) return null;
            return typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
        } catch {
            return null;
        }
    },

    // 서비스 계정 → OAuth2 액세스 토큰
    async _getVertexAccessToken() {
        // 캐시된 토큰이 유효하면 재사용
        if (cachedAccessToken && Date.now() < tokenExpiry - 60000) {
            return cachedAccessToken;
        }

        const sa = this._getServiceAccount();
        if (!sa) throw new Error('Vertex AI 서비스 계정이 없습니다');

        // JWT 생성
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: 'RS256', typ: 'JWT' };
        const payload = {
            iss: sa.client_email,
            scope: 'https://www.googleapis.com/auth/cloud-platform',
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600,
        };

        const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
        const b64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const signInput = `${b64Header}.${b64Payload}`;

        const sign = crypto.createSign('RSA-SHA256');
        sign.update(signInput);
        const signature = sign.sign(sa.private_key, 'base64url');

        const jwt = `${signInput}.${signature}`;

        // JWT → 액세스 토큰 교환
        const resp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
        });

        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`OAuth 토큰 발급 실패 (${resp.status}): ${err}`);
        }

        const data = await resp.json();
        cachedAccessToken = data.access_token;
        tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
        console.log('[AI] Vertex AI 액세스 토큰 발급 완료');
        return cachedAccessToken;
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

    async sendMessageWithImage(messages, imageBase64) {
        const lastUserIdx = messages.findLastIndex(m => m.role === 'user');
        if (lastUserIdx === -1) return this.sendMessage(messages);

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

        return this.sendMessage(modified);
    },
};

export default AIClient;