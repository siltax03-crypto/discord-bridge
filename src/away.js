import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'away.json');
const MAX_TIMEOUT = 2 ** 31 - 1;

// { channelId: untilTimestamp(ms) }
let map = {};
const timers = {};
let sendBack = null;

const Away = {
    init(sendBackFn) {
        sendBack = sendBackFn;
        this._load();
        const now = Date.now();
        for (const [cid, until] of Object.entries(map)) {
            if (until <= now) delete map[cid];
            else this._scheduleComeback(cid);
        }
        this._save();
        const n = Object.keys(map).length;
        if (n) console.log(`[Away] ${n}개 채널 잠수 복원`);
    },

    _load() {
        try {
            map = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
            if (typeof map !== 'object' || !map) map = {};
        } catch { map = {}; }
    },
    _save() {
        try { fs.writeFileSync(FILE, JSON.stringify(map, null, 2), 'utf-8'); } catch { /* 무시 */ }
    },

    isAway(channelId) {
        const u = map[channelId];
        return !!u && Date.now() < u;
    },

    setAway(channelId, minutes) {
        if (!Number.isFinite(minutes)) return;
        const mins = Math.min(Math.max(minutes, 1), 24 * 60); // 1분 ~ 24시간
        map[channelId] = Date.now() + mins * 60_000;
        this._save();
        this._scheduleComeback(channelId);
        console.log(`[Away] 채널 ${channelId} ${mins}분 잠수 시작`);
    },

    clear(channelId) {
        delete map[channelId];
        clearTimeout(timers[channelId]);
        delete timers[channelId];
        this._save();
    },

    _scheduleComeback(channelId) {
        clearTimeout(timers[channelId]);
        const wait = Math.max(0, (map[channelId] || 0) - Date.now());
        const t = setTimeout(async () => {
            delete timers[channelId];
            delete map[channelId];
            this._save();
            if (sendBack) await sendBack(channelId);
        }, Math.min(wait, MAX_TIMEOUT));
        t.unref?.();
        timers[channelId] = t;
    },
};

export default Away;
