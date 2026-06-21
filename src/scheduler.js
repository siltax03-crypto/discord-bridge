import ChatHistory from './chat-history.js';

/**
 * 선톡 스케줄러 (외부 의존성 없음, setTimeout 기반)
 *
 * config.proactive = {
 *   enabled: false,        // 틈틈이 선톡 on/off
 *   idleMinHours: 3,       // 마지막 대화 후 최소 이만큼 조용하면
 *   idleMaxHours: 8,       // 최대 이 정도 사이 랜덤 시점에 선톡
 *   activeHours: [9, 23]   // 이 시간대(시)에만 선톡
 * }
 *
 * 특정 시각 알람("8시에 깨워줘", "2시 약속 리마인드")은 여기가 아니라
 * 대화에서 인식하는 reminders.js가 담당한다.
 */

let timers = [];
let tz = 'Asia/Seoul';
const HOUR = 60 * 60 * 1000;

function rand(min, max) {
    return min + Math.random() * (max - min);
}

// 설정된 timezone 기준의 현재 시(hour). 서버가 UTC여도 서울 시간으로 판정.
function hourInTz() {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date());
    const h = parseInt(s, 10);
    return h === 24 ? 0 : h;
}

function inActiveHours(activeHours) {
    if (!Array.isArray(activeHours) || activeHours.length !== 2) return true;
    const h = hourInTz();
    const [start, end] = activeHours;
    // start<=end: 같은 날 구간 / start>end: 자정 넘김(예: 9~3시)
    return start <= end ? h >= start && h <= end : h >= start || h <= end;
}

const Scheduler = {
    init(config, sendProactive) {
        this.stop();
        tz = config.timezone || 'Asia/Seoul';
        const p = config.proactive;
        if (!p) return;

        const channelIds = Object.keys(config.channels || {});
        if (channelIds.length === 0) return;

        // --- 틈틈이 선톡 ---
        if (p.enabled) {
            const min = (p.idleMinHours || 3) * HOUR;
            const max = (p.idleMaxHours || 8) * HOUR;
            for (const channelId of channelIds) {
                this._scheduleIdle(channelId, min, max, p.activeHours, sendProactive);
            }
            console.log(`[Scheduler] 틈틈이 선톡 활성 (${channelIds.length}개 채널)`);
        }
    },

    _scheduleIdle(channelId, min, max, activeHours, sendProactive) {
        const wait = rand(min, max);
        const t = setTimeout(async () => {
            const idle = Date.now() - ChatHistory.lastTimestamp(channelId);
            if (idle >= min && inActiveHours(activeHours)) {
                await sendProactive(channelId, "It's been quiet for a while. Reach out first: naturally share a moment from your day right now (what you're doing, something that just happened) or ask how they're doing.");
            }
            // 다시 예약
            this._scheduleIdle(channelId, min, max, activeHours, sendProactive);
        }, wait);
        timers.push(t);
    },

    stop() {
        for (const t of timers) clearTimeout(t);
        timers = [];
    },
};

export default Scheduler;
