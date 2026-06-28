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

    // 제목이 실제로 그 작품인지 검증 (엉뚱한 자막 방지)
    _matches(item, title) {
        const fd = item.attributes?.feature_details || {};
        const hay = `${fd.title || ''} ${fd.movie_name || ''} ${fd.parent_title || ''} ${item.attributes?.release || ''}`.toLowerCase();
        const q = (title || '').toLowerCase().replace(/[^a-z0-9가-힣 ]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!q) return false;
        if (hay.includes(q)) return true;
        const words = q.split(' ').filter((w) => w.length >= 2);
        if (words.length && words.every((w) => hay.includes(w))) return true;
        return false;
    },

    // 한 언어로 검색 → 제목 맞는 첫 결과의 file_id (없으면 null)
    async _search(headers, title, language) {
        const url = `${API}/subtitles?query=${encodeURIComponent(title)}&languages=${language}`;
        const r = await fetch(url, { headers });
        if (!r.ok) return null;
        const d = await r.json();
        const items = (d.data || []).filter((it) => this._matches(it, title));
        const chosen = items[0];
        if (!chosen) return null;
        return { fileId: chosen.attributes?.files?.[0]?.file_id, name: chosen.attributes?.release || (chosen.attributes?.feature_details?.title || title), lang: language };
    },

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
            // 1) 검색 — 제목 일치하는 것만. 요청 언어 없으면 영어로 폴백.
            let hit = await this._search(headers, title, language);
            if (!hit && language !== 'en') hit = await this._search(headers, title, 'en');
            if (!hit?.fileId) return { error: `"${title}" 자막을 못 찾았어요. 제목(특히 영어 원제)이 정확한지 확인해줘.` };
            const fileId = hit.fileId;
            const item = { attributes: { release: hit.name } };

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
