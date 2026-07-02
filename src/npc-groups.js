import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'npcgroups.json');

// /npc 로 만든 NPC그룹 채널들 (config.json은 플러그인 소유라 별도 저장 → 기동 시 채널매핑에 병합)
// { channelId: { character, npcs:[{name,avatarUrl}], guildId, categoryId, srcChannel } }
let cache = null;

const NpcGroups = {
    _load() {
        if (cache) return cache;
        try { cache = JSON.parse(fs.readFileSync(FILE, 'utf-8')); if (typeof cache !== 'object' || !cache) cache = {}; }
        catch { cache = {}; }
        return cache;
    },
    _save() { try { fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf-8'); } catch { /* 무시 */ } },

    entries() { return Object.entries(this._load()); },
    get(channelId) { return this._load()[channelId] || null; },

    add(channelId, data) {
        this._load();
        cache[channelId] = { npcs: [], ...data };
        this._save();
        return cache[channelId];
    },
    setNpcs(channelId, npcs) {
        this._load();
        if (!cache[channelId]) return false;
        cache[channelId].npcs = npcs;
        this._save();
        return true;
    },
    remove(channelId) {
        this._load();
        if (!cache[channelId]) return false;
        delete cache[channelId];
        this._save();
        return true;
    },
};

export default NpcGroups;
