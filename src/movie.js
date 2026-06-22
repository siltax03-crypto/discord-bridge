import http from 'http';

// 브라우저 확장 → SillyTavern 플러그인 → (localhost) 이 서버로 자막/제어가 들어온다.
// 외부 포트를 열지 않고 127.0.0.1 에만 바인딩 (ST 플러그인이 같은 서버에서 프록시).
let server = null;
let token = '';
let handlers = {};

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; if (data.length > 2_000_000) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve(null); } });
        req.on('error', () => resolve(null));
    });
}

const Movie = {
    // onStart({character, movie, site}), onSub({cues}), onEnd({}), onReview?
    init({ port = 8788, token: tok = '', onStart, onSub, onEnd } = {}) {
        token = tok || '';
        handlers = { onStart, onSub, onEnd };
        this.stop();
        server = http.createServer(async (req, res) => {
            const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj || {})); };
            if (req.method !== 'POST') return send(405, { error: 'POST only' });
            const body = await readBody(req);
            if (!body) return send(400, { error: 'bad json' });
            if (token && body.token !== token) return send(401, { error: 'bad token' });

            const url = (req.url || '').split('?')[0];
            try {
                if (url.endsWith('/movie/start')) {
                    const r = await handlers.onStart?.({ character: body.character, movie: body.movie, site: body.site, group: !!body.group });
                    return send(200, r || { ok: true });
                }
                if (url.endsWith('/movie/sub')) {
                    // cues: [{ t: 초, text }] 또는 단일 {t,text}
                    const cues = Array.isArray(body.cues) ? body.cues : (body.text ? [{ t: body.t || 0, text: body.text }] : []);
                    handlers.onSub?.({ cues });
                    return send(200, { ok: true });
                }
                if (url.endsWith('/movie/end')) {
                    const r = await handlers.onEnd?.({});
                    return send(200, r || { ok: true });
                }
                return send(404, { error: 'unknown route' });
            } catch (e) {
                console.error('[Movie] 처리 오류:', e.message);
                return send(500, { error: e.message });
            }
        });
        server.on('error', (e) => console.error('[Movie] 서버 오류:', e.message));
        server.listen(port, '127.0.0.1', () => console.log(`[Movie] 수신 서버 127.0.0.1:${port} (자막 스트림 대기)`));
    },

    stop() {
        if (server) { try { server.close(); } catch { /* 무시 */ } server = null; }
    },
};

export default Movie;
