// .srt / .vtt 자막 파싱 + 싱크용 텍스트 매칭

// "00:01:23,456" 또는 "00:01:23.456" → ms
function tsToMs(ts) {
    const m = ts.trim().match(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/);
    if (!m) return null;
    return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (+m[4].padEnd(3, '0'));
}

// 태그/마크업 제거
function clean(t) {
    return (t || '')
        .replace(/<[^>]+>/g, '')
        .replace(/\{[^}]*\}/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

const Srt = {
    // 텍스트(.srt/.vtt) → [{ start, end, text }] (ms)
    parse(content) {
        const text = (content || '').replace(/\r/g, '');
        const cues = [];
        // 블록 = 빈 줄로 구분
        for (const block of text.split(/\n\s*\n/)) {
            const lines = block.split('\n').filter((l) => l.trim() !== '');
            if (!lines.length) continue;
            // 타임코드 줄 찾기 ( --> 포함 )
            const tcIdx = lines.findIndex((l) => l.includes('-->'));
            if (tcIdx === -1) continue;
            const tc = lines[tcIdx].split('-->');
            const start = tsToMs(tc[0]);
            const end = tsToMs(tc[1] || '');
            if (start == null) continue;
            const body = clean(lines.slice(tcIdx + 1).join(' '));
            if (body) cues.push({ start, end: end ?? start + 3000, text: body });
        }
        cues.sort((a, b) => a.start - b.start);
        return cues;
    },

    // 들은 대사 한 줄 → 가장 비슷한 cue의 start(ms) 반환 (싱크용). 없으면 null
    findTimeByText(cues, line) {
        const q = clean(line).toLowerCase();
        if (!q || !cues.length) return null;
        const qWords = q.split(' ').filter((w) => w.length >= 2);
        let best = null, bestScore = 0;
        for (const c of cues) {
            const ct = c.text.toLowerCase();
            let score = 0;
            if (ct.includes(q) || q.includes(ct)) score = 100 + Math.min(q.length, ct.length);
            else {
                // 단어 겹침 점수
                for (const w of qWords) if (ct.includes(w)) score += w.length;
            }
            if (score > bestScore) { bestScore = score; best = c; }
        }
        return bestScore >= 4 ? best.start : null;
    },
};

export default Srt;
