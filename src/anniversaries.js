import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'anniversaries.json');

// { channelId: [ { label, date:'YYYY-MM-DD', type:'since'|'yearly' } ] }
//  - since  : 그 날부터 며칠째(D+N). 사귄 날/처음 만난 날. 100일·1주년 마일스톤도 계산.
//  - yearly : 매년 반복(생일/기념일). 다음 도래까지 며칠, 오늘이면 당일.
let cache = null;

const DAY = 86400000;

const Anniv = {
    _load() {
        if (cache) return cache;
        try {
            cache = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
            if (typeof cache !== 'object' || !cache) cache = {};
        } catch { cache = {}; }
        return cache;
    },
    _save() {
        try { fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf-8'); } catch { /* 무시 */ }
    },

    list(channelId) {
        return this._load()[channelId] || [];
    },

    add(channelId, label, date, type = 'since') {
        this._load();
        if (!cache[channelId]) cache[channelId] = [];
        cache[channelId].push({ label, date, type });
        this._save();
    },

    remove(channelId, index) {
        this._load();
        const arr = cache[channelId];
        if (!arr || index < 0 || index >= arr.length) return false;
        arr.splice(index, 1);
        this._save();
        return true;
    },

    rename(oldId, newId) {
        this._load();
        if (cache[oldId] === undefined) return;
        cache[newId] = cache[oldId];
        delete cache[oldId];
        this._save();
    },

    /**
     * 지정 tz 기준 오늘 날짜로 각 기념일 상태 계산.
     * @returns [{ label, type, days, milestone, isToday, text }]
     *   - since:  days = D+N(오늘 포함 며칠째), milestone = 임박/당일 마일스톤 문구
     *   - yearly: days = 다음 도래까지 남은 일수(0=오늘), isToday
     */
    status(channelId, timezone = 'Asia/Seoul') {
        const arr = this.list(channelId);
        if (!arr.length) return [];
        // tz 기준 오늘 자정(로컬) 을 YYYY-MM-DD 로 얻어 UTC 자정으로 환산
        const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short' }).format(new Date());
        const today = Date.UTC(...todayStr.split('-').map((n, i) => (i === 1 ? +n - 1 : +n)));

        return arr.map((a) => {
            const [y, m, d] = a.date.split('-').map(Number);
            if (a.type === 'yearly') {
                let next = Date.UTC(new Date(today).getUTCFullYear(), m - 1, d);
                if (next < today) next = Date.UTC(new Date(today).getUTCFullYear() + 1, m - 1, d);
                const days = Math.round((next - today) / DAY);
                const isToday = days === 0;
                let text;
                if (isToday) text = `TODAY is ${a.label} 🎉`;
                else if (days <= 7) text = `${a.label} in ${days} day(s)`;
                else text = `${a.label}: ${days} days away`;
                return { label: a.label, type: 'yearly', days, isToday, text };
            }
            // since: 그 날부터 며칠째 (당일=D+1 한국식이 아니라 경과일 D+N: 당일 0)
            const start = Date.UTC(y, m - 1, d);
            const days = Math.round((today - start) / DAY);
            // 임박 마일스톤: 100/200/300일, 1·2·3주년
            const milestones = [100, 200, 300, 365, 500, 730, 1000, 1095];
            let milestone = '';
            for (const ms of milestones) {
                const left = ms - days;
                if (left === 0) { milestone = `TODAY is the ${ms}-day milestone! 🎉`; break; }
                if (left > 0 && left <= 5) { milestone = `${ms}-day milestone in ${left} day(s)`; break; }
            }
            const text = `${a.label}: D+${days}${milestone ? ` — ${milestone}` : ''}`;
            return { label: a.label, type: 'since', days, milestone, isToday: !!milestone && milestone.startsWith('TODAY'), text };
        });
    },
};

export default Anniv;
