import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODES_FILE = path.join(__dirname, '..', 'data', 'modes.json');

// { channelId: 'chat' | 'rp' }
let cache = null;

const Modes = {
    _load() {
        if (cache) return cache;
        try {
            cache = JSON.parse(fs.readFileSync(MODES_FILE, 'utf-8'));
        } catch {
            cache = {};
        }
        return cache;
    },

    _save() {
        try {
            fs.writeFileSync(MODES_FILE, JSON.stringify(cache, null, 2), 'utf-8');
        } catch {
            /* 무시 */
        }
    },

    get(channelId) {
        return this._load()[channelId] || 'chat';
    },

    set(channelId, mode) {
        this._load();
        cache[channelId] = mode;
        this._save();
    },
};

export default Modes;
