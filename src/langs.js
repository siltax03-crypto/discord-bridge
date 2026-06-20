import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LANGS_FILE = path.join(__dirname, '..', 'data', 'langs.json');

// { channelId: 'ko' | 'en' }  — 채널별 응답 언어 (없으면 config 전역 language 사용)
let cache = null;

const Langs = {
    _load() {
        if (cache) return cache;
        try {
            cache = JSON.parse(fs.readFileSync(LANGS_FILE, 'utf-8'));
        } catch {
            cache = {};
        }
        return cache;
    },

    _save() {
        try {
            fs.writeFileSync(LANGS_FILE, JSON.stringify(cache, null, 2), 'utf-8');
        } catch {
            /* 무시 */
        }
    },

    // 채널 지정 언어, 없으면 fallback(전역 config.language)
    get(channelId, fallback = 'ko') {
        return this._load()[channelId] || fallback;
    },

    set(channelId, lang) {
        this._load();
        cache[channelId] = lang;
        this._save();
    },
};

export default Langs;
