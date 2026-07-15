import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_DIR = path.join(__dirname, '..', 'data', 'history');

let maxMessages = 50;

const ChatHistory = {
    init(config) {
        maxMessages = config.maxHistoryMessages || 50;
        if (!fs.existsSync(HISTORY_DIR)) {
            fs.mkdirSync(HISTORY_DIR, { recursive: true });
        }
    },

    _getFilePath(channelId) {
        return path.join(HISTORY_DIR, `${channelId}.json`);
    },

    _load(channelId) {
        const filePath = this._getFilePath(channelId);
        if (!fs.existsSync(filePath)) {
            return { channelId, messages: [] };
        }
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            return { channelId, messages: [] };
        }
    },

    _save(channelId, data) {
        // 최대 메시지 수 유지
        if (data.messages.length > maxMessages) {
            data.messages = data.messages.slice(-maxMessages);
        }
        fs.writeFileSync(this._getFilePath(channelId), JSON.stringify(data, null, 2), 'utf-8');
    },

    addMessage(channelId, role, content, author = '') {
        const data = this._load(channelId);
        data.messages.push({
            role,
            content,
            author,
            timestamp: new Date().toISOString(),
        });
        this._save(channelId, data);
    },

    getMessages(channelId, limit) {
        const data = this._load(channelId);
        const count = limit || maxMessages;
        return data.messages.slice(-count);
    },

    /**
     * AI API용 OpenAI 메시지 형식으로 변환
     * @returns {Array} [{role: 'user'|'assistant', content: string}]
     */
    toAPIMessages(channelId, limit) {
        const messages = this.getMessages(channelId, limit);
        return messages.map(m => ({
            role: m.role,
            content: m.content,
        }));
    },

    // 마지막 메시지 시각(ms). 없으면 0
    lastTimestamp(channelId) {
        const data = this._load(channelId);
        const last = data.messages[data.messages.length - 1];
        if (!last?.timestamp) return 0;
        const t = Date.parse(last.timestamp);
        return Number.isNaN(t) ? 0 : t;
    },

    removeLastUserMessage(channelId) {
        const data = this._load(channelId);
        for (let i = data.messages.length - 1; i >= 0; i--) {
            if (data.messages[i].role === 'user') {
                data.messages.splice(i, 1);
                this._save(channelId, data);
                return true;
            }
        }
        return false;
    },

    // 마지막 메시지가 봇(assistant) 응답이면 제거 (재시도용)
    removeLastAssistantMessage(channelId) {
        const data = this._load(channelId);
        const last = data.messages[data.messages.length - 1];
        if (last?.role === 'assistant') {
            data.messages.pop();
            this._save(channelId, data);
            return true;
        }
        return false;
    },

    // 접두어로 시작하는 가장 최근 메시지 1개 삭제.
    // 첨부파일만 있는 메시지(음성메모 등)는 본문 매칭이 안 돼서 이걸로 정리한다.
    removeLastByPrefix(channelId, prefix) {
        const data = this._load(channelId);
        for (let i = data.messages.length - 1; i >= 0; i--) {
            const c = (data.messages[i].content || '').trim();
            if (typeof c === 'string' && c.startsWith(prefix)) {
                data.messages.splice(i, 1);
                this._save(channelId, data);
                return true;
            }
        }
        return false;
    },

    // 내용이 일치하는 가장 최근 메시지 1개 제거 (디코에서 메시지를 지웠을 때 동기화용)
    // 분할 전송된 봇 메시지의 한 조각만 지운 경우 그 묶음 전체를 제거.
    removeByContent(channelId, content) {
        const target = (content || '').trim();
        if (!target) return false;
        const data = this._load(channelId);
        for (let i = data.messages.length - 1; i >= 0; i--) {
            const c = (data.messages[i].content || '').trim();
            if (c === target || c.split(/\n\s*\n/).map((s) => s.trim()).includes(target)) {
                data.messages.splice(i, 1);
                this._save(channelId, data);
                return true;
            }
        }
        return false;
    },

    // 채널 통째 이름 변경(닉/복제로 채널 ID가 바뀔 때): 파일 이동
    rename(oldId, newId) {
        const oldPath = this._getFilePath(oldId);
        const newPath = this._getFilePath(newId);
        try { if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath); } catch { /* 무시 */ }
    },

    clear(channelId) {
        const data = { channelId, messages: [] };
        this._save(channelId, data);
        try { fs.unlinkSync(this._getFilePath(channelId)); } catch { /* 무시 */ }
    },
};

export default ChatHistory;