/**
 * SillyTavern Server Plugin — discord-bridge-config
 *
 * discord-bridge의 config.json을 ST UI(확장)에서 편집할 수 있게 해주는 서버 플러그인.
 * 브라우저(확장)는 서버 파일을 직접 못 쓰므로, 이 플러그인이 파일 I/O와 목록 조회를 대신한다.
 *
 * 마운트 경로: /api/plugins/discord-bridge-config
 *
 * 환경변수:
 *   DISCORD_BRIDGE_PATH  — discord-bridge 폴더 경로 (기본: /home/ubuntu/discord-bridge)
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const express = require('express');

const jsonParser = express.json({ limit: '4mb' });

// --- 경로 계산 ---
// 플러그인은 ST 루트에서 실행된다 (./start.sh 기준 cwd = ST 루트)
const ST_ROOT = process.cwd();

// discord-bridge는 SillyTavern과 형제 폴더라고 가정 (부모 폴더 안의 discord-bridge).
// 위치가 다르면 환경변수 DISCORD_BRIDGE_PATH로 지정.
const BRIDGE_PATH = process.env.DISCORD_BRIDGE_PATH || path.join(ST_ROOT, '..', 'discord-bridge');
const CONFIG_PATH = path.join(BRIDGE_PATH, 'config.json');
const STATUS_PATH = path.join(BRIDGE_PATH, 'data', 'bot-status.json');
const SETTINGS_CANDIDATES = [
    path.join(ST_ROOT, 'data', 'default-user', 'settings.json'),
    path.join(ST_ROOT, 'settings.json'),
];
const CHAR_DIR_CANDIDATES = [
    path.join(ST_ROOT, 'data', 'default-user', 'characters'),
    path.join(ST_ROOT, 'public', 'characters'),
];

const DISCORD_API = 'https://discord.com/api/v10';

// --- 유틸 ---
function readJson(p, fallback = null) {
    try {
        if (!fs.existsSync(p)) return fallback;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
        return fallback;
    }
}

function firstExisting(candidates) {
    for (const p of candidates) if (fs.existsSync(p)) return p;
    return null;
}

// PNG tEXt 'chara' 청크에서 캐릭터 카드 JSON 추출 (st-reader.js와 동일 로직)
function readPngCard(filePath) {
    try {
        const buf = fs.readFileSync(filePath);
        if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
        let offset = 8;
        while (offset + 8 < buf.length) {
            const length = buf.readUInt32BE(offset);
            const type = buf.toString('ascii', offset + 4, offset + 8);
            const dataStart = offset + 8;
            const dataEnd = dataStart + length;
            if (type === 'tEXt' && dataEnd <= buf.length) {
                const chunk = buf.subarray(dataStart, dataEnd);
                const nullIdx = chunk.indexOf(0);
                if (nullIdx !== -1 && chunk.toString('ascii', 0, nullIdx) === 'chara') {
                    const b64 = chunk.toString('ascii', nullIdx + 1);
                    return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
                }
            }
            offset = dataEnd + 4;
        }
    } catch {
        /* skip broken cards */
    }
    return null;
}

// --- 라우트 핸들러 ---

// 봇 config.json 읽기
function getConfig(req, res) {
    const config = readJson(CONFIG_PATH, null);
    if (!config) {
        return res.status(404).json({ error: `config.json을 찾을 수 없습니다: ${CONFIG_PATH}` });
    }
    // 토큰류는 절대 평문으로 안 보냄. "저장됨 여부"만 알려준다.
    const hasToken = !!(config.discordToken && !config.discordToken.includes('여기에'));
    const hasDevKey = !!(config.devKey || process.env.DISCORD_BRIDGE_DEV_KEY);
    const hasPersonaBot = !!(config.personaBotToken && !config.personaBotToken.includes('여기에'));

    const safe = { ...config };
    delete safe.devKey;
    safe.discordToken = hasToken ? '__SAVED__' : '';
    delete safe.personaBotToken; // 평문 노출 금지
    // 채널 토큰: 평문 제거하고 저장여부 플래그(tokenSaved)만
    const safeChannels = {};
    for (const [id, c] of Object.entries(config.channels || {})) {
        const copy = { ...c };
        copy.tokenSaved = !!(c.token && !c.token.includes('여기에'));
        delete copy.token;
        safeChannels[id] = copy;
    }
    safe.channels = safeChannels;

    // 멤버(멀티봇) 토큰도 평문 제거 + 저장여부 플래그
    safe.members = (config.members || []).map((m) => {
        const copy = { ...m };
        copy.tokenSaved = !!(m.token && !m.token.includes('여기에'));
        delete copy.token;
        return copy;
    });

    res.json({ config: safe, hasToken, hasDevKey, hasPersonaBot, configPath: CONFIG_PATH });
}

// 봇 config.json 쓰기
function postConfig(req, res) {
    const incoming = req.body || {};
    const current = readJson(CONFIG_PATH, {});

    // 토큰류는 "실제 새 값(긴 문자열)"이 왔을 때만 갱신. 그 외(undefined/__SAVED__/빈값)는 기존 유지.
    // → 저장 눌러도 토큰이 빈값/마스킹으로 덮어써지지 않음 (사용자 요구사항).
    const keepIfNotReal = (sent, cur) => {
        const real = typeof sent === 'string' && sent.length > 20 && sent !== '__SAVED__' && !sent.includes('여기에');
        return real ? sent : (cur || '');
    };
    incoming.discordToken = keepIfNotReal(incoming.discordToken, current.discordToken);
    if ('personaBotToken' in incoming || current.personaBotToken) {
        incoming.personaBotToken = keepIfNotReal(incoming.personaBotToken, current.personaBotToken);
    }

    // 채널 토큰: 채널별로 동일 규칙 + tokenSaved 같은 임시 플래그 제거
    if (incoming.channels) {
        for (const [id, c] of Object.entries(incoming.channels)) {
            if (!c || typeof c !== 'object') continue;
            delete c.tokenSaved;
            c.token = keepIfNotReal(c.token, current.channels?.[id]?.token);
            if (!c.token) delete c.token;
        }
    }

    // 멤버(멀티봇) 토큰: 인덱스 기준으로 기존 값 보존
    if (Array.isArray(incoming.members)) {
        incoming.members = incoming.members.map((m, i) => {
            if (!m || typeof m !== 'object') return m;
            const copy = { ...m };
            delete copy.tokenSaved;
            copy.token = keepIfNotReal(copy.token, current.members?.[i]?.token);
            if (!copy.token) delete copy.token;
            return copy;
        });
    }

    const merged = { ...current, ...incoming };

    try {
        if (!fs.existsSync(path.dirname(CONFIG_PATH))) {
            return res.status(500).json({ error: `폴더 없음: ${path.dirname(CONFIG_PATH)}` });
        }
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

// ST 커넥션 프로필 목록
function getProfiles(req, res) {
    const settingsPath = firstExisting(SETTINGS_CANDIDATES);
    const settings = readJson(settingsPath, {});
    const cm = settings.extension_settings?.connectionManager;
    const profiles = (cm?.profiles || []).map((p) => ({
        id: p.id,
        name: p.name,
        api: p.api || '',
        model: p.model || '',
        selected: p.id === cm?.selectedProfile,
    }));
    res.json({ profiles });
}

// ST 캐릭터 이름 목록
function getCharacters(req, res) {
    const dir = firstExisting(CHAR_DIR_CANDIDATES);
    if (!dir) return res.json({ characters: [] });
    const names = new Set();
    for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.png')) {
            const card = readPngCard(path.join(dir, file));
            const name = card?.name || card?.data?.name;
            if (name) names.add(name);
        } else if (file.endsWith('.json')) {
            const card = readJson(path.join(dir, file), null);
            const name = card?.name || card?.data?.name;
            if (name) names.add(name);
        }
    }
    res.json({ characters: [...names].sort() });
}

// 카드 이름으로 카드 본문(description 등 전체) 읽기
function readCardBodyByName(cardName) {
    const dir = firstExisting(CHAR_DIR_CANDIDATES);
    if (!dir) return null;
    for (const file of fs.readdirSync(dir)) {
        let card = null;
        if (file.endsWith('.png')) card = readPngCard(path.join(dir, file));
        else if (file.endsWith('.json')) card = readJson(path.join(dir, file), null);
        if (!card) continue;
        const nm = card.name || card.data?.name;
        if (nm !== cardName) continue;
        const d = card.data || card;
        return [d.description, d.personality, d.scenario, d.first_mes, d.mes_example]
            .filter(Boolean).join('\n');
    }
    return null;
}

// 중복 제거 + 샘플을 맨 앞으로
function order(arr, sample) {
    const seen = new Set();
    const out = [];
    for (const n of arr) { const k = n.toLowerCase(); if (k && !seen.has(k)) { seen.add(k); out.push(n); } }
    if (!out.some((x) => x.toLowerCase() === sample.toLowerCase())) out.unshift(sample);
    out.sort((a, b) => (a.toLowerCase() === sample.toLowerCase() ? -1 : b.toLowerCase() === sample.toLowerCase() ? 1 : 0));
    return out;
}

// 단체 시트에서 "샘플 이름"이 등장하는 패턴을 보고 같은 패턴의 다른 인물 이름들을 추출
function getSheetMembers(req, res) {
    const cardName = req.query.card;
    const sample = (req.query.sample || '').trim();
    if (!cardName || !sample) return res.json({ names: [] });

    const body = readCardBodyByName(cardName);
    if (!body) return res.json({ names: [], error: '카드 본문을 못 읽었어요.' });

    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const clean = (s) => s.trim().replace(/\s+/g, ' ').replace(/['’]s$/, '').replace(/[.,;]+$/, ''); // "Gaz's"→"Gaz", "Krueger."→"Krueger"
    const U = "\\p{Lu}";
    // 이름 토큰: 대문자 시작 + 글자/어포스트로피/하이픈 이어짐 + (공백 뒤 또 한 단어) 최대 2단어
    //   greedy로 단어 전체를 잡아 "Gho" 같은 잘림 방지. 예: König, John Price, Kim Hong-jin
    const NAME = `${U}[\\p{L}'’.\\-]+(?:\\s${U}?[\\p{L}'’.\\-]+){0,2}`;

    // 샘플이 시트에서 "실제로 등장하는 자리"를 보고, 그 앞의 라벨/구분자 패턴을 그대로 따라간다.
    // 이게 명단 줄보다 우선 — 본명(Full Name= John Price)으로 넣으면 본명들이 나와야 하므로.
    const idx = body.toLowerCase().indexOf(sample.toLowerCase());

    // 명단 줄 폴백 함수 (위 패턴이 실패할 때만 사용)
    const tryRoster = () => {
        const listRe = new RegExp(`${NAME}(?:\\s*,\\s*(?:and\\s+)?${NAME})+(?:\\s+and\\s+${NAME})?`, 'gu');
        let lm;
        while ((lm = listRe.exec(body)) !== null) {
            const parts = lm[0].split(/\s*,\s*|\s+and\s+/).map(clean).filter(Boolean);
            if (parts.length >= 3 && parts.some((p) => p.toLowerCase() === sample.toLowerCase())) return parts;
        }
        return null;
    };

    if (idx === -1) {
        const r = tryRoster();
        return res.json({ names: r ? order(r, sample) : [sample] });
    }

    const before = body.slice(Math.max(0, idx - 40), idx); // 샘플 바로 앞 40자
    let extractRe = null;

    // 1) "라벨= 샘플" / "라벨: 샘플"  (예: Full Name= , Name= , Alias= )
    const lab = before.match(/([A-Za-z][A-Za-z ]{0,20})\s*[=:]\s*$/);
    if (lab) {
        extractRe = new RegExp(`${esc(lab[1].trim())}\\s*[=:]\\s*(${U}${NAME})(?=[\\n.,;()]|$)`, 'gu');
    }
    // 2) "(샘플 ... information" → "(이름 ... information"
    else if (new RegExp(`\\(\\s*${esc(sample)}\\b[^)]*information`, 'i').test(body)) {
        extractRe = new RegExp(`\\(\\s*(${U}${NAME})['’]?s?\\s+information`, 'giu');
    }

    // 샘플 자리 패턴(extractRe)을 최우선. 그담 흔한 패턴 폴백.
    const fallbacks = [
        new RegExp(`\\(\\s*(${U}${NAME})['’]?s?\\s+information`, 'giu'),
        new RegExp(`information\\s+from\\s+(${U}${NAME})(?=[\\n.,;)]|$)`, 'giu'),
        new RegExp(`(?:^|\\n)\\s*#{1,4}\\s*(?:[^\\s\\w]\\s*)?(${U}${NAME})(?=[\\n(]|$)`, 'gmu'),
        new RegExp(`Full Name\\s*[=:]\\s*(${U}${NAME})(?=[\\n.,;()]|$)`, 'gu'),
    ];
    const tries = extractRe ? [extractRe, ...fallbacks] : fallbacks;

    for (const re of tries) {
        const found = new Set();
        let mm;
        while ((mm = re.exec(body)) !== null) {
            const nm = clean(mm[1]);
            if (nm.length >= 2 && nm.length <= 40) found.add(nm);
        }
        if (found.size >= 2) return res.json({ names: order([...found], sample) });
    }
    // 최후: 명단 줄(A, B and C)
    const r = tryRoster();
    return res.json({ names: r ? order(r, sample) : [sample] });
}

// ST 페르소나 이름 목록
function getPersonas(req, res) {
    const settings = readJson(firstExisting(SETTINGS_CANDIDATES), {});
    const personas = settings.power_user?.personas || {};
    const names = [...new Set(Object.values(personas))].filter(Boolean).sort();
    res.json({ personas: names });
}

// 디스코드 채널 목록 (봇이 들어가 있는 길드의 텍스트 채널)
async function getChannels(req, res) {
    const config = readJson(CONFIG_PATH, {});
    // 멀티봇이면 페르소나 전담봇 토큰(모든 채널에 초대됨) 우선, 없으면 첫 멤버 토큰. 단일봇은 discordToken.
    let token = config.discordToken;
    if (config.botMode === 'multi') {
        token = config.personaBotToken
            || (config.members || []).map((m) => m && m.token).find((t) => t && !t.includes('여기에'))
            || '';
    }
    if (!token || token.includes('여기에')) {
        return res.json({ channels: [], error: '채널을 긁을 봇 토큰이 없습니다. (멀티봇: 페르소나 전담봇 또는 멤버 토큰 필요)' });
    }
    const headers = { Authorization: `Bot ${token}` };
    try {
        const guildsResp = await fetch(`${DISCORD_API}/users/@me/guilds`, { headers });
        if (!guildsResp.ok) {
            return res.json({ channels: [], error: `디스코드 API 오류 (${guildsResp.status}). 토큰 확인 필요.` });
        }
        const guilds = await guildsResp.json();
        const channels = [];
        for (const g of guilds) {
            const chResp = await fetch(`${DISCORD_API}/guilds/${g.id}/channels`, { headers });
            if (!chResp.ok) continue;
            const chs = await chResp.json();
            for (const c of chs) {
                if (c.type === 0) {
                    // 0 = GUILD_TEXT
                    channels.push({ id: c.id, name: c.name, guild: g.name });
                }
            }
        }
        res.json({ channels });
    } catch (e) {
        res.json({ channels: [], error: e.message });
    }
}

// 봇 실행 상태 (heartbeat 파일 기반)
function getStatus(req, res) {
    const status = readJson(STATUS_PATH, null);
    if (!status?.ts) return res.json({ running: false, reason: 'heartbeat 없음' });
    const ageSec = (Date.now() - status.ts) / 1000;
    res.json({ running: ageSec < 90, ageSec: Math.round(ageSec), ts: status.ts });
}

// 봇 재시작 (pm2)
function postRestart(req, res) {
    const name = process.env.PM2_NAME || 'discord-bridge';
    exec(`pm2 restart ${name}`, { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
            return res.status(500).json({ error: (stderr || err.message || '').trim() || 'pm2 restart 실패' });
        }
        res.json({ ok: true, output: (stdout || '').trim() });
    });
}

// 지정한 git ref(브랜치)로 받아 재배포 + 봇 재시작
function deployFrom(ref, res) {
    const name = process.env.PM2_NAME || 'discord-bridge';
    const pluginDest = path.join(ST_ROOT, 'plugins', 'discord-bridge-config.js');
    const extDir =
        firstExisting([
            path.join(ST_ROOT, 'data', 'default-user', 'extensions', 'discord-bridge'),
            path.join(ST_ROOT, 'public', 'scripts', 'extensions', 'third-party', 'discord-bridge'),
        ]) || path.join(ST_ROOT, 'data', 'default-user', 'extensions', 'discord-bridge');

    const cmd = [
        `cd "${BRIDGE_PATH}"`,
        'git fetch origin',
        `git checkout ${ref}`,
        `git reset --hard origin/${ref}`,
        'npm install --no-audit --no-fund',
        `cp st-plugin/index.js "${pluginDest}"`,
        `mkdir -p "${extDir}"`,
        `cp st-extension/manifest.json st-extension/index.js st-extension/style.css "${extDir}/"`,
        `pm2 restart ${name}`,
    ].join(' && ');

    exec(cmd, { timeout: 120000, shell: '/bin/bash' }, (err, stdout, stderr) => {
        if (err) {
            return res.status(500).json({ error: (stderr || err.message || '').trim(), output: (stdout || '').trim() });
        }
        res.json({ ok: true, output: (stdout || '').trim() });
    });
}

// 일반 업데이트: 안정판(master)
function postUpdate(req, res) {
    deployFrom('master', res);
}

// 개발용 업데이트: dev 브랜치 + 비밀키 검사 (나만 작동)
function postDevUpdate(req, res) {
    const config = readJson(CONFIG_PATH, {});
    const expected = config.devKey || process.env.DISCORD_BRIDGE_DEV_KEY || '';
    const provided = (req.body && req.body.key) || '';
    if (!expected) {
        return res.status(403).json({ error: '개발 키가 서버에 설정되지 않았습니다 (config.devKey).' });
    }
    if (provided !== expected) {
        return res.status(403).json({ error: '개발 키가 일치하지 않습니다.' });
    }
    const branch = config.devBranch || 'dev';
    deployFrom(branch, res);
}

// --- 플러그인 진입점 ---
async function init(router) {
    router.get('/config', getConfig);
    router.post('/config', jsonParser, postConfig);
    router.get('/profiles', getProfiles);
    router.get('/characters', getCharacters);
    router.get('/sheet-members', getSheetMembers);
    router.get('/personas', getPersonas);
    router.get('/channels', getChannels);
    router.get('/status', getStatus);
    router.post('/restart', jsonParser, postRestart);
    router.post('/update', jsonParser, postUpdate);
    router.post('/dev-update', jsonParser, postDevUpdate);
    console.log('[discord-bridge-config] 플러그인 로드됨. bridge 경로:', BRIDGE_PATH);
}

async function exit() {
    /* nothing to clean up */
}

module.exports = {
    init,
    exit,
    info: {
        id: 'discord-bridge-config',
        name: 'Discord Bridge Config',
        description: 'discord-bridge의 config.json을 ST UI에서 편집',
    },
};
