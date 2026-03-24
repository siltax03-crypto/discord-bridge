import STReader from './st-reader.js';

let profile = null;
let config = {};

const AIClient = {
    init(cfg) {
        config = cfg;
        profile = STReader.getConnectionProfile(cfg.connectionProfile);
    },

    async sendMessage(messages, options = {}) {
        const api = profile.api || '';
        const model = profile.model || '';
        const maxTokens = options.maxTokens || config.maxResponseTokens || 1000;

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

        const modelName = model || 'gemini-2.0-flash';
        const body = {
            contents,
            generationConfig: { maxOutputTokens: maxTokens },
        };
        if (systemInstruction) {
            body.system_instruction = { parts: [{ text: systemInstruction }] };
        }

        // API 키로 AI Studio 엔드포인트 사용
        const apiKey = profile.apiKey;
        if (!apiKey) throw new Error('Gemini API 키가 없습니다');
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

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
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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