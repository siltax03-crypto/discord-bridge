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
