import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'sets.json');

// 한 캐릭터 = 카테고리 1개 + 채널 3개(chat/rp/summary) 묶음.
// [{ character, guildId, categoryId, chat, rp, summary, summaries:[{ts, dir, text}] }]
let cache = null;

const Sets = {
    _load() {
        if (cache) return cache;
        try {
            cache = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
            if (!Array.isArray(cache)) cache = [];
        } catch { cache = []; }
        return cache;
    },
    _save() {
        try { fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf-8'); } catch { /* 무시 */ }
    },

    list() { return this._load(); },

    add(set) {
        this._load();
        cache.push({ summaries: [], ...set });
        this._save();
        return set;
    },

    // 세트 1개 제거 (객체 참조 또는 캐릭터명)
    remove(setOrChar) {
        this._load();
        const before = cache.length;
        if (typeof setOrChar === 'string') {
            const n = setOrChar.toLowerCase();
            cache = cache.filter((s) => (s.character || '').toLowerCase() !== n);
        } else {
            cache = cache.filter((s) => s !== setOrChar);
        }
        if (cache.length !== before) this._save();
        return before - cache.length;
    },

    // 채널 ID 변경(nuke 복제) 시 세트 내 해당 역할의 채널 ID 갱신
    renameChannel(oldId, newId) {
        this._load();
        let changed = false;
        for (const s of cache) {
            if (s.chat === oldId) { s.chat = newId; changed = true; }
            if (s.rp === oldId) { s.rp = newId; changed = true; }
            if (s.summary === oldId) { s.summary = newId; changed = true; }
        }
        if (changed) this._save();
    },

    findByCharacter(name) {
        if (!name) return null;
        const n = name.toLowerCase();
        return this._load().find((s) => (s.character || '').toLowerCase() === n) || null;
    },

    // 채널 id가 세트의 어느 역할인지 → { set, role:'chat'|'rp'|'summary' } 또는 null
    findByChannel(channelId) {
        for (const s of this._load()) {
            if (s.chat === channelId) return { set: s, role: 'chat' };
            if (s.rp === channelId) return { set: s, role: 'rp' };
            if (s.summary === channelId) return { set: s, role: 'summary' };
        }
        return null;
    },

    // 요약 추가 (dir: 'chat→rp' | 'rp→chat'), 최근 것만 유지
    addSummary(character, dir, text) {
        this._load();
        const s = this.findByCharacter(character);
        if (!s) return;
        if (!Array.isArray(s.summaries)) s.summaries = [];
        s.summaries.push({ ts: Date.now(), dir, text });
        if (s.summaries.length > 50) s.summaries = s.summaries.slice(-50);
        this._save();
    },

    // 주입용 최근 요약 N개 (오래된→최신)
    recentSummaries(character, limit = 6) {
        const s = this.findByCharacter(character);
        if (!s || !Array.isArray(s.summaries)) return [];
        return s.summaries.slice(-limit);
    },
};

export default Sets;
