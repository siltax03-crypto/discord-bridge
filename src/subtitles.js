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
            // 1) 검색 — 언어 필터 없이 제목으로 찾고, 결과 중 제목 일치 + 언어 우선순위로 고름
            const sUrl = `${API}/subtitles?query=${encodeURIComponent(title)}`;
            const sr = await fetch(sUrl, { headers });
            if (!sr.ok) return { error: `검색 실패 (${sr.status})` };
            const sd = await sr.json();
            const all = sd.data || [];
            // 디버그: 뭐가 왔는지
            const titles = all.slice(0, 6).map((it) => `${it.attributes?.feature_details?.title || '?'}[${it.attributes?.language || '?'}]`);
            console.log(`[Subtitles] "${title}" 검색결과 ${all.length}개:`, titles.join(', '));

            const matched = all.filter((it) => this._matches(it, title));
            if (!matched.length) {
                return { error: `"${title}" 자막을 못 찾았어요. (검색결과: ${titles.slice(0, 3).join(', ') || '없음'}) — 영어 원제로 다시.` };
            }
            // 다운로드 많은 순으로 (완성도 높은 자막 우선)
            const sorted = matched.slice().sort((a, b) => (b.attributes?.download_count || 0) - (a.attributes?.download_count || 0));
            const byLang = (lang) => sorted.find((it) => (it.attributes?.language || '').toLowerCase() === lang);
            // 한국어 우선 → 영어. 둘 다 없으면 엉뚱한 언어 쓰지 말고 실패.
            const chosen = byLang(language) || byLang('ko') || byLang('en');
            if (!chosen) {
                const langs = [...new Set(matched.map((it) => it.attributes?.language))].join(',');
                return { error: `"${title}" 한국어/영어 자막이 없어요 (있는 언어: ${langs}). .srt 직접 첨부 추천.` };
            }
            console.log(`[Subtitles] "${title}" 선택: ${chosen.attributes?.language} / ${chosen.attributes?.release || ''}`);
            const fileId = chosen.attributes?.files?.[0]?.file_id;
            if (!fileId) return { error: `자막 파일 ID 없음` };
            const item = { attributes: { release: `${chosen.attributes?.release || chosen.attributes?.feature_details?.title || title} [${chosen.attributes?.language}]` } };

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
