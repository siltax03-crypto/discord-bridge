const $ = (id) => document.getElementById(id);
const setStatus = (t) => { $('status').textContent = t; };

// 저장된 설정 불러오기
chrome.storage.local.get(['base', 'token', 'character', 'group'], (c) => {
    $('base').value = c.base || '';
    $('token').value = c.token || '';
    $('character').value = c.character || '';
    $('group').checked = !!c.group;
});
chrome.runtime.sendMessage({ type: 'status' }, (r) => {
    if (r?.active) setStatus(`🎬 보는 중: ${r.movie || ''}`);
});

function save() {
    chrome.storage.local.set({
        base: $('base').value.trim(),
        token: $('token').value.trim(),
        character: $('character').value.trim(),
        group: $('group').checked,
    });
}

$('start').addEventListener('click', async () => {
    save();
    const base = $('base').value.trim();
    const token = $('token').value.trim();
    const character = $('character').value.trim();
    if (!base || !character) { setStatus('⚠️ 주소와 캐릭터 이름을 입력하세요.'); return; }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { setStatus('⚠️ 탭을 찾을 수 없어요.'); return; }

    let info;
    try {
        info = await chrome.tabs.sendMessage(tab.id, { type: 'getInfo' });
    } catch {
        setStatus('⚠️ 이 탭에서 자막을 못 읽어요. 넷플/유튜브/디즈니+ 영상 페이지에서 다시 시도하세요.');
        return;
    }
    if (!info?.hasVideo) { setStatus('⚠️ 재생 중인 영상이 없어요.'); return; }

    const group = $('group').checked;
    const movie = ($('movie').value || '').trim() || info.title;
    setStatus(`🎬 "${movie}" 시작 중...`);
    chrome.runtime.sendMessage(
        { type: 'start', base, token, character, movie, site: info.site, group, tabId: tab.id },
        (r) => {
            if (r?.ok) setStatus(`🎬 "${info.title}" 같이보기 시작! (디스코드 확인)`);
            else setStatus(`⚠️ 시작 실패: ${r?.error || '알 수 없음'}`);
        },
    );
});

$('stop').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'end' }, (r) => {
        setStatus(r?.ok ? '■ 종료했어요. 리뷰가 디스코드에 남아요.' : `⚠️ ${r?.error || '종료 실패'}`);
    });
});
