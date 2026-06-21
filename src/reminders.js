import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'reminders.json');
const MAX_TIMEOUT = 2 ** 31 - 1; // setTimeout 최대치 (~24.8일)

let list = [];
let sendFn = null;
let timezone = 'Asia/Seoul';
const timers = {}; // { reminderId: timeoutHandle }

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
        // 중복 방지: 같은 채널에서 ±3분 이내 이미 등록된 리마인더가 있으면 스킵
        // (모델이 매 답장마다 같은 [REMIND] 태그를 다시 붙여 수십 개 쌓이는 것 방지)
        const dup = list.find((r) => r.channelId === channelId && Math.abs(r.fireAt - fireAt) < 3 * 60 * 1000);
        if (dup) {
            console.log('[Reminders] 중복 리마인더 스킵 (이미 비슷한 시각에 등록됨)');
            return dup;
        }
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
        timers[r.id] = t;
    },

    async _fire(r) {
        clearTimeout(timers[r.id]);
        delete timers[r.id];
        list = list.filter((x) => x.id !== r.id);
        this._save();
        if (!sendFn) return;
        await sendFn(r.channelId, `It's the reminder time you promised. Naturally bring up this: ${r.text}`);
    },

    // --- 조회/삭제 (/reminders 명령용) ---
    listForChannel(channelId) {
        return list.filter((r) => r.channelId === channelId).sort((a, b) => a.fireAt - b.fireAt);
    },

    removeById(id) {
        const r = list.find((x) => x.id === id);
        if (!r) return false;
        clearTimeout(timers[id]);
        delete timers[id];
        list = list.filter((x) => x.id !== id);
        this._save();
        return true;
    },

    removeByIndex(channelId, index) {
        const arr = this.listForChannel(channelId);
        if (index < 0 || index >= arr.length) return null;
        const r = arr[index];
        this.removeById(r.id);
        return r;
    },

    clearChannel(channelId) {
        const arr = this.listForChannel(channelId);
        for (const r of arr) this.removeById(r.id);
        return arr.length;
    },

    // 채널 ID 변경(nuke) 시 예약된 리마인더의 채널을 새 ID로 (타이머는 그대로, 발송 대상만 갱신)
    renameChannel(oldId, newId) {
        let changed = false;
        for (const r of list) if (r.channelId === oldId) { r.channelId = newId; changed = true; }
        if (changed) this._save();
    },

    // 표시용: tz 기준 "MM/DD HH:MM" 포맷
    formatTime(fireAt) {
        return new Intl.DateTimeFormat('sv-SE', {
            timeZone: timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }).format(new Date(fireAt));
    },
};

export default Reminders;
