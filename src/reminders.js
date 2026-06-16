import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'reminders.json');
const MAX_TIMEOUT = 2 ** 31 - 1; // setTimeout 최대치 (~24.8일)

let list = [];
let sendFn = null;
let timezone = 'Asia/Seoul';

// tz 기준 벽시계 시각의 각 구성요소
function tzParts(date, tz) {
    const f = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const p = Object.fromEntries(f.formatToParts(date).map((o) => [o.type, o.value]));
    return {
        y: +p.year, mo: +p.month, d: +p.day,
        h: +(p.hour === '24' ? '0' : p.hour), mi: +p.minute, s: +p.second,
    };
}

const Reminders = {
    init(config, sendProactive) {
        sendFn = sendProactive;
        timezone = config.timezone || 'Asia/Seoul';
        this._load();

        // 과거 것 정리 + 미래 것 재예약 (재시작 후에도 유지)
        const now = Date.now();
        const future = list.filter((r) => r.fireAt > now);
        list = future;
        this._save();
        for (const r of list) this._schedule(r);
        if (list.length) console.log(`[Reminders] ${list.length}개 리마인더 재예약`);
    },

    _load() {
        try {
            list = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
            if (!Array.isArray(list)) list = [];
        } catch {
            list = [];
        }
    },

    _save() {
        try {
            fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf-8');
        } catch {
            /* 무시 */
        }
    },

    /**
     * "YYYY-MM-DD HH:MM" (tz 벽시계 기준) → 실제 fireAt(ms). 과거면 null.
     * 두 벽시계 시각을 같은 tz로 보고 UTC로 환산해 차이를 내면, 서버 TZ와 무관하게 정확한 delay가 나온다.
     */
    parseToFireAt(timeStr) {
        const m = String(timeStr).trim().match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
        if (!m) return null;
        const [, y, mo, d, h, mi] = m.map(Number);

        const now = new Date();
        const np = tzParts(now, timezone);
        const nowEquiv = Date.UTC(np.y, np.mo - 1, np.d, np.h, np.mi, np.s);
        const targetEquiv = Date.UTC(y, mo - 1, d, h, mi, 0);

        const delay = targetEquiv - nowEquiv;
        if (delay <= 0) return null;
        return Date.now() + delay;
    },

    add(channelId, fireAt, text) {
        const r = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, channelId, fireAt, text };
        list.push(r);
        this._save();
        this._schedule(r);
        console.log(`[Reminders] 등록: 채널 ${channelId}, ${new Date(fireAt).toLocaleString('ko-KR')} → "${text}"`);
        return r;
    },

    _schedule(r) {
        const delay = r.fireAt - Date.now();
        if (delay <= 0) return this._fire(r);
        const wait = Math.min(delay, MAX_TIMEOUT);
        const t = setTimeout(() => {
            if (r.fireAt - Date.now() > 0) this._schedule(r); // 아직 멀면 재예약
            else this._fire(r);
        }, wait);
        t.unref?.();
    },

    async _fire(r) {
        list = list.filter((x) => x.id !== r.id);
        this._save();
        if (!sendFn) return;
        await sendFn(r.channelId, `약속했던 리마인드 시간이야. 다음 내용을 자연스럽게 전해: ${r.text}`);
    },
};

export default Reminders;
