// OpenSubtitles.com 에서 자막 자동 다운로드 (선택 — config에 키/계정 있을 때만)
// config.openSub = { apiKey, username, password }  또는  config.openSubApiKey / openSubUser / openSubPass

const API = 'https://api.opensubtitles.com/api/v1';

function creds(config) {
    const o = config.openSub || {};
    return {
        apiKey: o.apiKey || config.openSubApiKey || '',
        username: o.username || config.openSubUser || '',
        password: o.password || config.openSubPass || '',
    };
}

const Subtitles = {
    enabled(config) { return !!creds(config).apiKey; },

    // 제목으로 자막(.srt 텍스트) 받아오기. 실패 시 null + 이유
    async fetchByTitle(config, title, language = 'ko') {
        const { apiKey, username, password } = creds(config);
        if (!apiKey) return { error: 'OpenSubtitles 미설정' };
        const headers = {
            'Api-Key': apiKey,
            'Content-Type': 'application/json',
            'User-Agent': 'discord-bridge-watch v1.0',
        };
        try {
            // 1) 검색
            const sUrl = `${API}/subtitles?query=${encodeURIComponent(title)}&languages=${language}&order_by=download_count`;
            const sr = await fetch(sUrl, { headers });
            if (!sr.ok) return { error: `검색 실패 (${sr.status})` };
            const sd = await sr.json();
            const item = (sd.data || [])[0];
            const fileId = item?.attributes?.files?.[0]?.file_id;
            if (!fileId) return { error: `"${title}" 자막을 못 찾음 (언어 ${language})` };

            // 2) 다운로드 토큰 (로그인 필요)
            let auth = {};
            if (username && password) {
                const lr = await fetch(`${API}/login`, { method: 'POST', headers, body: JSON.stringify({ username, password }) });
                if (lr.ok) { const ld = await lr.json(); if (ld.token) auth = { Authorization: `Bearer ${ld.token}` }; }
            }
            // 3) 다운로드 링크
            const dr = await fetch(`${API}/download`, { method: 'POST', headers: { ...headers, ...auth }, body: JSON.stringify({ file_id: fileId }) });
            if (!dr.ok) {
                const t = await dr.text();
                return { error: `다운로드 거부 (${dr.status}) — 계정/쿼터 확인. ${t.slice(0, 120)}` };
            }
            const dd = await dr.json();
            if (!dd.link) return { error: '다운로드 링크 없음' };

            // 4) 실제 자막 파일
            const fr = await fetch(dd.link);
            if (!fr.ok) return { error: `자막 파일 받기 실패 (${fr.status})` };
            const srtText = await fr.text();
            return { ok: true, srtText, name: item?.attributes?.release || title };
        } catch (e) {
            return { error: e.message };
        }
    },
};

export default Subtitles;
