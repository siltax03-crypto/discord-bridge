// 페이지(넷플/유튜브/디즈니+)에서 자막 + 재생위치를 읽어 백그라운드로 보낸다.
(() => {
    const host = location.hostname;
    const site = host.includes('youtube') ? 'youtube'
        : host.includes('netflix') ? 'netflix'
            : host.includes('disney') ? 'disney'
                : host.includes('coupangplay') ? 'coupang' : 'unknown';

    // 사이트별 자막 컨테이너 선택자 (렌더된 자막 DOM을 읽음 — 포맷 파싱 불필요)
    const CAPTION_SELECTORS = {
        youtube: ['.ytp-caption-segment', '.captions-text'],
        netflix: ['.player-timedtext-text-container', '.player-timedtext'],
        disney: ['.dss-subtitle-renderer-cue-window', '[class*="subtitle"]', '.TimedTextActiveCue'],
        coupang: ['.subtitle', '[class*="subtitle"]', '[class*="caption"]', '[class*="Subtitle"]'],
        unknown: ['[class*="caption"]', '[class*="subtitle"]'],
    };

    function getVideo() {
        const vids = [...document.querySelectorAll('video')];
        // 가장 길게 재생 중인(또는 처음) 비디오
        return vids.find((v) => !v.paused && v.currentTime > 0) || vids[0] || null;
    }

    function getCaptionText() {
        // 1) 표준 TextTrack activeCues — 사이트 DOM 클래스 몰라도 잡힘 (표준 플레이어)
        const v = getVideo();
        if (v && v.textTracks) {
            for (const tr of v.textTracks) {
                if (tr.mode === 'showing' || tr.mode === 'hidden') {
                    const cues = tr.activeCues;
                    if (cues && cues.length) {
                        const txt = [...cues].map((c) => (c.text || '')).join(' ').replace(/<[^>]+>/g, '').trim();
                        if (txt) return txt;
                    }
                }
            }
        }
        // 2) 사이트별 렌더된 자막 DOM
        for (const sel of CAPTION_SELECTORS[site]) {
            const nodes = document.querySelectorAll(sel);
            if (nodes.length) {
                const txt = [...nodes].map((n) => n.textContent.trim()).filter(Boolean).join(' ');
                if (txt) return txt;
            }
        }
        // 3) 자동탐지: 비디오 하단 영역에 떠 있는 짧은 텍스트 (클래스 몰라도 자막을 찾음)
        return genericCaption(v) || '';
    }

    // 비디오 하단 1/3 영역에 위치한, 컨트롤이 아닌 짧은 텍스트 요소를 자막으로 추정
    function genericCaption(v) {
        if (!v) return '';
        const vr = v.getBoundingClientRect();
        if (!vr.height) return '';
        let best = '';
        const els = document.querySelectorAll('span, p, div');
        for (const el of els) {
            if (el.children.length > 4) continue; // 텍스트 위주 요소만
            const t = (el.textContent || '').trim();
            if (!t || t.length < 2 || t.length > 150) continue;
            if (/^[\d:.\s/%-]+$/.test(t)) continue; // 시간/진행률 등 숫자만 → 제외
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            // 비디오 영역 안 + 하단 45% 지점 아래
            const inX = r.left >= vr.left - 40 && r.right <= vr.right + 40;
            const lowerHalf = r.top >= vr.top + vr.height * 0.5 && r.top <= vr.bottom + 60;
            if (inX && lowerHalf) {
                // 가장 아래쪽이면서 가장 긴 텍스트를 우선 (자막일 확률↑)
                if (t.length > best.length) best = t;
            }
        }
        return best;
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
        return (document.title || 'movie').replace(/\s*[-—|]\s*(YouTube|Netflix|Disney\+|Coupang Play|쿠팡플레이).*$/i, '').trim() || 'movie';
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
