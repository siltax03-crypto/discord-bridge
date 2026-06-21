import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTES_FILE = path.join(__dirname, '..', 'data', 'notes.json');

// { channelId: [ "노트1", "노트2", ... ] }
let cache = null;

const Notes = {
    _load() {
        if (cache) return cache;
        try {
            cache = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf-8'));
        } catch {
            cache = {};
        }
        return cache;
    },

    _save() {
        try {
            fs.writeFileSync(NOTES_FILE, JSON.stringify(cache, null, 2), 'utf-8');
        } catch {
            /* 무시 */
        }
    },

    list(channelId) {
        return this._load()[channelId] || [];
    },

    add(channelId, text) {
        this._load();
        if (!cache[channelId]) cache[channelId] = [];
        cache[channelId].push(text);
        this._save();
    },

    remove(channelId, index) {
        const arr = this.list(channelId);
        if (index < 0 || index >= arr.length) return false;
        arr.splice(index, 1);
        cache[channelId] = arr;
        this._save();
        return true;
    },

    clear(channelId) {
        this._load();
        delete cache[channelId];
        this._save();
    },

    rename(oldId, newId) {
        this._load();
        if (cache[oldId] === undefined) return;
        cache[newId] = cache[oldId];
        delete cache[oldId];
        this._save();
    },
};

export default Notes;
