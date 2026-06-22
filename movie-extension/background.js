// 서비스 워커: 콘텐츠 스크립트가 보낸 자막 큐를 모아 ST 플러그인(→봇)으로 전송.
// 시작/종료는 popup이 트리거.

let session = null; // { base, token, character, movie, site, tabId, buffer:[], flushTimer }

// ST는 POST에 CSRF 토큰을 요구(없으면 403). GET은 통과하므로 GET+쿼리로 보낸다.
async function post(base, token, sub, payload) {
    const params = new URLSearchParams({ token: token || '' });
    for (const [k, v] of Object.entries(payload || {})) {
        if (v === undefined || v === null) continue;
        params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const url = base.replace(/\/+$/, '') + '/api/plugins/discord-bridge-config/movie/' + sub + '?' + params.toString();
    const res = await fetch(url, { method: 'GET' });
    const text = await res.text().catch(() => '');
    let json = {}; try { json = JSON.parse(text); } catch { /* */ }
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}${res.status === 403 ? ' (ST가 거절 — 주소 확인)' : ''}`);
    return json;
}

function flush() {
    if (!session || session.buffer.length === 0) return;
    let cues = session.buffer.splice(0);
    if (cues.length > 30) cues = cues.slice(-30); // URL 길이 안전장치
    post(session.base, session.token, 'sub', { cues }).catch((e) => console.warn('[같이보기] 자막 전송 실패:', e.message));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        try {
            if (msg.type === 'start') {
                const { base, token, character, movie, site, tabId } = msg;
                await post(base, token, 'start', { character, movie, site });
                session = { base, token, character, movie, site, tabId, buffer: [], flushTimer: null };
                session.flushTimer = setInterval(flush, 5000);
                chrome.tabs.sendMessage(tabId, { type: 'begin' }).catch(() => {});
                sendResponse({ ok: true });
            } else if (msg.type === 'cues') {
                if (session) for (const c of msg.cues || []) session.buffer.push(c);
                sendResponse({ ok: true });
            } else if (msg.type === 'end') {
                if (session) {
                    clearInterval(session.flushTimer);
                    flush();
                    try { await post(session.base, session.token, 'end', {}); } catch (e) { console.warn('[같이보기] 종료 전송 실패:', e.message); }
                    try { chrome.tabs.sendMessage(session.tabId, { type: 'stop' }); } catch { /* */ }
                    session = null;
                }
                sendResponse({ ok: true });
            } else if (msg.type === 'status') {
                sendResponse({ active: !!session, movie: session?.movie || null });
            }
        } catch (e) {
            sendResponse({ ok: false, error: e.message });
        }
    })();
    return true; // async sendResponse
});
