// 서비스 워커는 MV3에서 수시로 잠들고 메모리 상태가 날아간다.
// → 세션 상태는 chrome.storage에 저장하고, 타이머 없이 "자막 들어올 때마다 즉시 전달".

function base2url(base, sub, params) {
    const qs = new URLSearchParams(params || {}).toString();
    return base.replace(/\/+$/, '') + '/api/plugins/discord-bridge-config/movie/' + sub + (qs ? '?' + qs : '');
}

async function callST(base, token, sub, payload) {
    const params = { token: token || '' };
    for (const [k, v] of Object.entries(payload || {})) {
        if (v === undefined || v === null) continue;
        params[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    const res = await fetch(base2url(base, sub, params), { method: 'GET' });
    const text = await res.text().catch(() => '');
    let json = {}; try { json = JSON.parse(text); } catch { /* */ }
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}${res.status === 403 ? ' (ST 로그인/주소 확인)' : ''}`);
    return json;
}

const getSess = () => new Promise((r) => chrome.storage.local.get(['movie'], (c) => r(c.movie || null)));
const setSess = (m) => new Promise((r) => chrome.storage.local.set({ movie: m }, r));
const clearSess = () => new Promise((r) => chrome.storage.local.remove(['movie'], r));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        try {
            if (msg.type === 'start') {
                const { base, token, character, movie, site, tabId } = msg;
                await callST(base, token, 'start', { character, movie, site });
                await setSess({ base, token, character, movie, site, tabId, active: true });
                try { chrome.tabs.sendMessage(tabId, { type: 'begin' }); } catch { /* */ }
                sendResponse({ ok: true });
            } else if (msg.type === 'cues') {
                const s = await getSess();
                if (s?.active && msg.cues?.length) {
                    await callST(s.base, s.token, 'sub', { cues: msg.cues }).catch((e) => console.warn('[같이보기] 자막 전송 실패:', e.message));
                }
                sendResponse({ ok: true });
            } else if (msg.type === 'end') {
                const s = await getSess();
                if (s?.active) {
                    try { await callST(s.base, s.token, 'end', {}); } catch (e) { console.warn('[같이보기] 종료 전송 실패:', e.message); }
                    try { chrome.tabs.sendMessage(s.tabId, { type: 'stop' }); } catch { /* */ }
                }
                await clearSess();
                sendResponse({ ok: true });
            } else if (msg.type === 'status') {
                const s = await getSess();
                sendResponse({ active: !!s?.active, movie: s?.movie || null });
            }
        } catch (e) {
            sendResponse({ ok: false, error: e.message });
        }
    })();
    return true; // async sendResponse
});
