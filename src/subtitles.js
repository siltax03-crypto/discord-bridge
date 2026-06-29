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

    // 제목이 실제로 그 작품인지 검증 (영화 feature/자막 둘 다)
    _matches(item, title) {
        const a = item.attributes || {};
        const fd = a.feature_details || {};
        const hay = `${a.title || ''} ${a.original_title || ''} ${fd.title || ''} ${fd.movie_name || ''} ${fd.parent_title || ''} ${a.release || ''}`.toLowerCase();
        const q = (title || '').toLowerCase().replace(/[^a-z0-9가-힣 ]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!q) return false;
        if (hay.includes(q)) return true;
        const words = q.split(' ').filter((w) => w.length >= 2);
        if (words.length && words.every((w) => hay.includes(w))) return true;
        return false;
    },

    // 영화(feature) ID로 그 작품의 자막만 검색 → 언어별 다운로드순 1개
    async _subsForFeature(headers, idParam, lang) {
        const r = await fetch(`${API}/subtitles?${idParam}&languages=${lang}&order_by=download_count`, { headers });
        if (!r.ok) return null;
        const d = await r.json();
        const it = (d.data || [])[0];
        if (!it) return null;
        return { fileId: it.attributes?.files?.[0]?.file_id, release: it.attributes?.release, lang };
    },

    // 제목으로 자막(.srt 텍스트) 받아오기 — 사이트처럼 (영화 찾기 → 그 영화 ID로 자막)
    async fetchByTitle(config, title, language = 'ko') {
        const { apiKey, username, password } = creds(config);
        if (!apiKey) return { error: 'OpenSubtitles 미설정' };
        const headers = { 'Api-Key': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'discord-bridge-watch v1.0' };
        try {
            // 제목에서 연도 분리 (예: "Aladdin 2019" → title=Aladdin, year=2019)
            const ym = (title || '').match(/\b(19|20)\d{2}\b/);
            const year = ym ? ym[0] : null;
            const cleanTitle = year ? title.replace(year, '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim() : title;

            // 1) 영화(feature) 검색 → 제목 맞는 것. 연도 지정 시 그 연도 우선.
            const ftr = await fetch(`${API}/features?query=${encodeURIComponent(cleanTitle)}`, { headers });
            if (!ftr.ok) return { error: `영화 검색 실패 (${ftr.status})` };
            const fd = await ftr.json();
            let feats = (fd.data || []).filter((f) => this._matches(f, cleanTitle));
            const log = (fd.data || []).slice(0, 8).map((f) => `${f.attributes?.title}(${f.attributes?.year || '?'})`);
            console.log(`[Subtitles] "${title}" 영화검색(year=${year || '-'}):`, log.join(', '));
            if (!feats.length) return { error: `"${title}" 영화를 못 찾았어요. 영어 원제로 다시 (검색: ${log.slice(0, 3).join(', ') || '없음'})` };
            if (year) {
                const byYear = feats.filter((f) => String(f.attributes?.year) === year);
                if (byYear.length) feats = byYear;
                else return { error: `"${cleanTitle}" ${year}년 영화를 못 찾았어요. 있는 연도: ${feats.map((f) => f.attributes?.year).filter(Boolean).join(', ')}` };
            }
            const totalSubs = (f) => Object.values(f.attributes?.subtitles_counts || {}).reduce((a, b) => a + (+b || 0), 0);
            feats.sort((a, b) => totalSubs(b) - totalSubs(a));
            const feat = feats[0];
            const idParam = feat.attributes?.tmdb_id ? `tmdb_id=${feat.attributes.tmdb_id}` : `id=${feat.id}`;
            console.log(`[Subtitles] 선택 영화: ${feat.attributes?.title}(${feat.attributes?.year || '?'}) ${idParam}`);

            // 2) 그 영화의 자막 — 한국어 우선, 없으면 영어
            const pick = await this._subsForFeature(headers, idParam, language)
                || (language !== 'ko' && await this._subsForFeature(headers, idParam, 'ko'))
                || await this._subsForFeature(headers, idParam, 'en');
            if (!pick?.fileId) return { error: `"${feat.attributes?.title}" 한국어/영어 자막이 없어요. .srt 직접 첨부 추천.` };
            console.log(`[Subtitles] 자막 선택: ${pick.lang} / ${pick.release || ''}`);
            const fileId = pick.fileId;
            const item = { attributes: { release: `${pick.release || feat.attributes?.title || title} [${pick.lang}]` } };

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
