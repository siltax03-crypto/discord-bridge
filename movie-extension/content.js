// 페이지(넷플/유튜브/디즈니+)에서 자막 + 재생위치를 읽어 백그라운드로 보낸다.
(() => {
    const host = location.hostname;
    const site = host.includes('youtube') ? 'youtube'
        : host.includes('netflix') ? 'netflix'
            : host.includes('disney') ? 'disney' : 'unknown';

    // 사이트별 자막 컨테이너 선택자 (렌더된 자막 DOM을 읽음 — 포맷 파싱 불필요)
    const CAPTION_SELECTORS = {
        youtube: ['.ytp-caption-segment', '.captions-text'],
        netflix: ['.player-timedtext-text-container', '.player-timedtext'],
        disney: ['.dss-subtitle-renderer-cue-window', '[class*="subtitle"]', '.TimedTextActiveCue'],
        unknown: ['[class*="caption"]', '[class*="subtitle"]'],
    };

    function getVideo() {
        const vids = [...document.querySelectorAll('video')];
        // 가장 길게 재생 중인(또는 처음) 비디오
        return vids.find((v) => !v.paused && v.currentTime > 0) || vids[0] || null;
    }

    function getCaptionText() {
        for (const sel of CAPTION_SELECTORS[site]) {
            const nodes = document.querySelectorAll(sel);
            if (nodes.length) {
                const txt = [...nodes].map((n) => n.textContent.trim()).filter(Boolean).join(' ');
                if (txt) return txt;
            }
        }
        return '';
    }

    function getTitle() {
        if (site === 'youtube') {
            const h = document.querySelector('h1.ytd-watch-metadata, h1.title');
            if (h?.textContent.trim()) return h.textContent.trim();
        }
        if (site === 'netflix') {
            const t = document.querySelector('[data-uia="video-title"]');
            if (t?.textContent.trim()) return t.textContent.trim().replace(/\n+/g, ' ');
        }
        return (document.title || 'movie').replace(/\s*[-—|]\s*(YouTube|Netflix|Disney\+).*$/i, '').trim() || 'movie';
    }

    let observer = null;
    let pollTimer = null;
    let lastText = '';
    let streaming = false;

    function tick() {
        if (!streaming) return;
        const txt = getCaptionText();
        if (txt && txt !== lastText) {
            lastText = txt;
            const v = getVideo();
            chrome.runtime.sendMessage({ type: 'cues', cues: [{ t: v ? Math.round(v.currentTime) : 0, text: txt }] }).catch(() => {});
        }
    }

    function start() {
        if (streaming) return;
        streaming = true;
        lastText = '';
        // 자막 DOM 변화 감지 + 폴링 백업
        observer = new MutationObserver(tick);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        pollTimer = setInterval(tick, 700);
    }

    function stop() {
        streaming = false;
        if (observer) { observer.disconnect(); observer = null; }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === 'getInfo') {
            sendResponse({ site, title: getTitle(), hasVideo: !!getVideo() });
        } else if (msg.type === 'begin') {
            start();
            sendResponse({ ok: true });
        } else if (msg.type === 'stop') {
            stop();
            sendResponse({ ok: true });
        }
        return true;
    });
})();
