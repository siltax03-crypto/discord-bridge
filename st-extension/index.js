/**
 * SillyTavern Extension — Discord Bridge 설정 UI
 *
 * discord-bridge의 config.json을 ST 설정 패널에서 편집한다.
 * 실제 파일 I/O와 목록 조회는 서버 플러그인(discord-bridge-config)이 담당한다.
 */

import { getRequestHeaders } from '../../../../script.js';

const PLUGIN_BASE = '/api/plugins/discord-bridge-config';
const LANGS = [
    { value: 'ko', label: '한국어' },
    { value: 'en', label: 'English' },
];

// 현재 편집 중인 상태
let state = {
    discordToken: '',
    tokenSaved: false,
    botMode: 'single',
    personaBotSaved: false, // 페르소나 전담봇 토큰 저장 여부(멀티)
    connectionProfile: '',
    language: 'ko',
    maxHistoryMessages: 50,
    maxResponseTokens: 1000,
    stPath: '',
    splitMessages: true,
    chatSlang: true,
    proactive: { enabled: false, photos: false, idleMinHours: 3, idleMaxHours: 8, activeHours: [9, 23] },
    channels: {}, // 단일봇: { channelId: { character, persona?, tokenSaved? } }
    members: [],  // 멀티봇: [{ character|sheet, name?, persona?, tokenSaved? }]
};
let profiles = [];
let characters = [];
let personas = [];
let discordChannels = [];

// --- API 헬퍼 ---
async function apiGet(pathname) {
    const resp = await fetch(PLUGIN_BASE + pathname, { headers: getRequestHeaders() });
    if (!resp.ok) throw new Error(`${pathname} → ${resp.status}`);
    return resp.json();
}
async function apiPost(pathname, body) {
    const resp = await fetch(PLUGIN_BASE + pathname, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `${pathname} → ${resp.status}`);
    }
    return resp.json();
}

// --- 데이터 로드 ---
async function loadAll() {
    // config는 필수. 나머지(프로필/캐릭터/페르소나)는 하나 실패해도 UI는 떠야 한다.
    let cfgRes;
    try {
        cfgRes = await apiGet('/config');
    } catch (e) {
        $('#dbridge_status').html(`🔴 플러그인 연결 실패 — ${e.message} (플러그인 최신화 + ST 재시작 필요)`);
        console.error('[DiscordBridge] /config 실패', e);
        return;
    }

    try {
        const [profRes, charRes, persRes] = await Promise.all([
            apiGet('/profiles').catch((e) => (console.warn('[DiscordBridge] /profiles', e), { profiles: [] })),
            apiGet('/characters').catch((e) => (console.warn('[DiscordBridge] /characters', e), { characters: [] })),
            apiGet('/personas').catch((e) => (console.warn('[DiscordBridge] /personas', e), { personas: [] })),
        ]);

        const c = cfgRes.config || {};
        const p = c.proactive || {};
        state = {
            discordToken: '',
            tokenSaved: !!cfgRes.hasToken,
            botMode: c.botMode === 'multi' ? 'multi' : 'single',
            personaBotSaved: !!cfgRes.hasPersonaBot,
            connectionProfile: c.connectionProfile || c.connectionProfileId || '',
            imageProfile: c.imageProfile || '',
            language: c.language || 'ko',
            maxHistoryMessages: c.maxHistoryMessages ?? 50,
            maxResponseTokens: c.maxResponseTokens ?? 1000,
            stPath: c.stPath || '',
            splitMessages: c.splitMessages !== false,
            chatSlang: c.chatSlang !== false,
            movieToken: c.movieToken || '',
            openSub: c.openSub || {},
            liveKeySaved: !!c.liveApiKey,
            liveVoice: c.liveVoice || 'Charon',
            proactive: {
                enabled: !!p.enabled,
                photos: !!p.photos,
                idleMinHours: p.idleMinHours ?? 3,
                idleMaxHours: p.idleMaxHours ?? 8,
                activeHours: Array.isArray(p.activeHours) ? p.activeHours : [9, 23],
            },
            channels: c.channels || {},
            members: Array.isArray(c.members) ? c.members : [],
        };
        profiles = profRes.profiles || [];
        characters = charRes.characters || [];
        personas = persRes.personas || [];

        // 개발 키가 서버에 설정된 경우에만 dev 업데이트 버튼 노출
        $('#dbridge_devupdate').toggle(!!cfgRes.hasDevKey);

        render();
        refreshStatus();
        refreshChannels(); // 디스코드 채널은 느릴 수 있어 별도 로드
    } catch (e) {
        $('#dbridge_status').html(`🔴 플러그인 연결 실패 — ${e.message}`);
        console.error('[DiscordBridge]', e);
    }
}

async function refreshStatus() {
    try {
        const s = await apiGet('/status');
        $('#dbridge_status').html(
            s.running
                ? `🟢 봇 실행 중 (${s.ageSec}초 전 갱신)`
                : '🔴 봇 정지됨 (heartbeat 없음 — pm2 확인)',
        );
    } catch {
        $('#dbridge_status').html('⚪ 상태 알 수 없음');
    }
}

async function refreshChannels() {
    $('#dbridge_channels_note').text('디스코드 채널 불러오는 중...');
    try {
        const res = await apiGet('/channels');
        discordChannels = res.channels || [];
        $('#dbridge_channels_note').text(
            res.error ? `⚠ ${res.error}` : `${discordChannels.length}개 채널 감지됨`,
        );
    } catch (e) {
        $('#dbridge_channels_note').text(`⚠ 채널 로드 실패: ${e.message}`);
    }
    renderChannelRows();
}

// --- 렌더링 ---
function optionList(items, selected, mapper) {
    return items
        .map((it) => {
            const { value, label } = mapper(it);
            const sel = value === selected ? ' selected' : '';
            return `<option value="${escapeHtml(value)}"${sel}>${escapeHtml(label)}</option>`;
        })
        .join('');
}

function render() {
    // 봇 모드
    const multi = state.botMode === 'multi';
    $('#dbridge_botmode').val(state.botMode);
    $('#dbridge_single_box').toggle(!multi);
    $('#dbridge_multi_box').toggle(multi);
    $('#dbridge_single_map').toggle(!multi);
    $('#dbridge_multi_map').toggle(multi);

    // 메인 토큰 (단일봇): 비우면 기존 유지, 입력하면 교체
    $('#dbridge_token').val('')
        .attr('placeholder', state.tokenSaved ? '•••••••• (저장됨, 비우면 유지)' : '디스코드 봇 토큰 입력');

    // 페르소나 전담봇 토큰 (멀티)
    $('#dbridge_personabot').val('')
        .attr('placeholder', state.personaBotSaved ? '•••••••• (저장됨, 비우면 유지)' : '페르소나 전담봇 토큰 입력');

    // 프로필 드롭다운
    const profOpts =
        '<option value="">(ST에서 선택된 프로필 사용)</option>' +
        optionList(profiles, state.connectionProfile, (p) => ({
            value: p.name,
            label: `${p.name}  (${p.api} / ${p.model})${p.selected ? '  ★' : ''}`,
        }));
    $('#dbridge_profile').html(profOpts);

    // 이미지 전용 프로필 드롭다운 (채팅이 클로드/잼민프록시일 때 이미지/비전용 Gemini 키)
    const imgProfOpts =
        '<option value="">(채팅 프로필과 동일)</option>' +
        optionList(profiles, state.imageProfile, (p) => ({
            value: p.name,
            label: `${p.name}  (${p.api} / ${p.model})`,
        }));
    $('#dbridge_imageprofile').html(imgProfOpts);

    // 언어
    $('#dbridge_lang').html(optionList(LANGS, state.language, (l) => ({ value: l.value, label: l.label })));

    // 숫자
    $('#dbridge_history').val(state.maxHistoryMessages);
    $('#dbridge_tokens').val(state.maxResponseTokens);

    // 메시지/말투
    $('#dbridge_split').prop('checked', state.splitMessages);
    $('#dbridge_slang').prop('checked', state.chatSlang);

    // 영화 같이보기 토큰
    $('#dbridge_movietoken').val(state.movieToken || '');
    $('#dbridge_opensub').val(state.openSub?.apiKey || '');

    // Gemini Live (통화)
    $('#dbridge_livekey').val('')
        .attr('placeholder', state.liveKeySaved ? '•••••••• (저장됨, 비우면 유지)' : 'AI Studio API 키 (aistudio.google.com/apikey)');
    $('#dbridge_livevoice').val(state.liveVoice || 'Charon');

    // 선톡
    const p = state.proactive;
    $('#dbridge_proactive').prop('checked', p.enabled);
    $('#dbridge_proactive_photos').prop('checked', p.photos);
    $('#dbridge_idlemin').val(p.idleMinHours);
    $('#dbridge_idlemax').val(p.idleMaxHours);
    $('#dbridge_active_start').val(p.activeHours[0]);
    $('#dbridge_active_end').val(p.activeHours[1]);
    $('#dbridge_proactive_opts').toggle(p.enabled);

    if (multi) renderMemberRows();
    else renderChannelRows();
}

// --- 멀티봇: 멤버(캐릭터) 행 렌더. 행마다 개별/단체 ---
function renderMemberRows() {
    const $list = $('#dbridge_member_list').empty();
    if (!state.members.length) {
        $list.append('<div class="dbridge_hint">캐릭터가 없습니다. [+]로 추가하세요.</div>');
    }
    state.members.forEach((m, i) => {
        const saved = !!m.tokenSaved;
        // 단체 행 여부: sheet 키가 있으면(빈값이어도) 단체
        const group = ('sheet' in m) || !!m._group;

        // 단체 체크박스
        const groupCheck = `<label class="dbridge_inline" style="gap:4px"><input type="checkbox" class="dbridge_m_group"${group ? ' checked' : ''} /><span class="dbridge_hint">단체</span></label>`;

        // 식별 필드: 단체면 [시트 드롭다운 + 인물이름 + ➕], 개별이면 [캐릭터 드롭다운]
        let idField;
        if (group) {
            const sheetOpts = '<option value="">(시트 선택)</option>' +
                optionList(characters, m.sheet || '', (n) => ({ value: n, label: n })) +
                (m.sheet && !characters.includes(m.sheet) ? `<option value="${escapeHtml(m.sheet)}" selected>${escapeHtml(m.sheet)} (카드없음)</option>` : '');
            idField =
                `<span>시트</span><select class="text_pole dbridge_m_sheet">${sheetOpts}</select>` +
                `<span>인물</span><input type="text" class="text_pole dbridge_m_name" value="${escapeHtml(m.name || '')}" placeholder="첫 인물 적고 🔄 (예: John Price)" />` +
                `<div class="menu_button dbridge_m_extract" title="이 이름 패턴으로 시트 인물 자동 추출"><i class="fa-solid fa-wand-magic-sparkles"></i></div>` +
                `<div class="menu_button dbridge_m_addsame" title="같은 시트 인물 수동 추가"><i class="fa-solid fa-user-plus"></i></div>`;
        } else {
            const charOpts = '<option value="">(선택)</option>' +
                optionList(characters, m.character || '', (n) => ({ value: n, label: n })) +
                (m.character && !characters.includes(m.character) ? `<option value="${escapeHtml(m.character)}" selected>${escapeHtml(m.character)} (카드없음)</option>` : '');
            idField = `<span>캐릭터</span><select class="text_pole dbridge_m_char">${charOpts}</select>`;
        }

        const personaField =
            `<span>나(페르소나)</span><select class="text_pole dbridge_m_persona">${
                '<option value="">(자동)</option>' +
                optionList(personas, m.persona || '', (n) => ({ value: n, label: n })) +
                (m.persona && !personas.includes(m.persona) ? `<option value="${escapeHtml(m.persona)}" selected>${escapeHtml(m.persona)} (없음)</option>` : '')
            }</select>`;

        // 담당 채널 (단일 드롭다운, 다른 칸과 일관). 단톡은 같은 채널을 여러 멤버에 지정.
        const cur = Array.isArray(m.channels) ? (m.channels[0] || '') : '';
        const chOpts = '<option value="">(모든 채널)</option>' +
            (discordChannels.length > 0
                ? discordChannels.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === cur ? ' selected' : ''}>#${escapeHtml(c.name)}</option>`).join('')
                : (cur ? `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}</option>` : ''));
        const channelField =
            `<span>담당 채널</span><select class="text_pole dbridge_m_channel" title="단톡은 같은 채널을 여러 멤버에 지정">${chOpts}</select>`;

        // 아바타 URL (웹훅 방식: 봇 토큰 없이 이 URL+이름으로 단톡 전송)
        const avatarField =
            `<span>아바타 URL</span><input type="text" class="text_pole dbridge_m_avatar" value="${escapeHtml(m.avatarUrl || '')}" placeholder="imgur 등 이미지 링크 (토큰 없으면 웹훅으로 이 얼굴 사용)" />`;

        const $row = $(`
            <div class="dbridge_row" data-idx="${i}">
                ${groupCheck}
                ${idField}
                ${personaField}
                ${channelField}
                ${avatarField}
                <span>봇 토큰</span>
                <input type="password" class="text_pole dbridge_m_token" placeholder="${saved ? '•••••••• (저장됨, 비우면 유지)' : '비우면 웹훅으로 (아바타 URL 사용)'}" />
                <div class="menu_button dbridge_m_del" title="삭제"><i class="fa-solid fa-trash"></i></div>
            </div>
        `);
        $list.append($row);
    });
}

function renderChannelRows() {
    const $list = $('#dbridge_channel_list').empty();
    const entries = Object.entries(state.channels);

    if (entries.length === 0) {
        $list.append('<div class="dbridge_hint">매핑된 채널이 없습니다. [+ 추가]를 누르세요.</div>');
    }

    for (const [channelId, conf] of entries) {
        const chanOpts =
            discordChannels.length > 0
                ? optionList(discordChannels, channelId, (c) => ({
                      value: c.id,
                      label: `#${c.name}  (${c.guild})`,
                  }))
                : `<option value="${escapeHtml(channelId)}" selected>${escapeHtml(channelId)}</option>`;
        // 현재 ID가 목록에 없을 수도 있으니 보존용 옵션 추가
        const ensureOpt =
            discordChannels.length > 0 && !discordChannels.find((c) => c.id === channelId) && channelId
                ? `<option value="${escapeHtml(channelId)}" selected>${escapeHtml(channelId)} (감지 안됨)</option>`
                : '';

        const charOpts = optionList(characters, conf.character, (name) => ({ value: name, label: name }));
        const ensureChar =
            conf.character && !characters.includes(conf.character)
                ? `<option value="${escapeHtml(conf.character)}" selected>${escapeHtml(conf.character)} (카드 없음)</option>`
                : '';

        const personaOpts =
            '<option value="">(기본 페르소나)</option>' +
            optionList(personas, conf.persona || '', (name) => ({ value: name, label: name }));
        const ensurePersona =
            conf.persona && !personas.includes(conf.persona)
                ? `<option value="${escapeHtml(conf.persona)}" selected>${escapeHtml(conf.persona)} (없음)</option>`
                : '';

        const isGroup = !!conf.group;
        const isNpc = !!conf.npcGroup;
        const groupCheck = `<label class="dbridge_inline" style="gap:4px"><input type="checkbox" class="dbridge_row_groupchk"${isGroup ? ' checked' : ''} /><span class="dbridge_hint">단체(단톡)</span></label>`
            + `<label class="dbridge_inline" style="gap:4px"><input type="checkbox" class="dbridge_row_npcchk"${isNpc ? ' checked' : ''} /><span class="dbridge_hint">NPC그룹</span></label>`;

        // 캐릭터 선택부: 단체=[시트], NPC그룹=[메인 캐릭터], 개별=[캐릭터]
        let charField;
        if (isGroup) {
            const sheetOpts = '<option value="">(시트 선택)</option>' +
                optionList(characters, conf.sheet || '', (n) => ({ value: n, label: n })) +
                (conf.sheet && !characters.includes(conf.sheet) ? `<option value="${escapeHtml(conf.sheet)}" selected>${escapeHtml(conf.sheet)} (카드없음)</option>` : '');
            charField = `<span>시트</span><select class="text_pole dbridge_row_sheet">${sheetOpts}</select>`;
        } else {
            charField = `<span>${isNpc ? '메인' : '캐릭터'}</span><select class="text_pole dbridge_row_char">${ensureChar}${charOpts}</select>`;
        }

        // NPC그룹 인물 목록 (이름+아바타URL, 자동추출 없음 — NPC는 수동)
        let npcBox = '';
        if (isNpc) {
            const npcs = Array.isArray(conf.npcs) ? conf.npcs : [];
            const rows = npcs.map((m, mi) => `
                <div class="dbridge_npcmem" data-mi="${mi}" style="display:flex;gap:6px;align-items:center;margin:3px 0">
                    <input type="text" class="text_pole dbridge_npc_name" value="${escapeHtml(m.name || '')}" placeholder="NPC 이름 (예: Captain America)" style="flex:0 0 35%" />
                    <input type="text" class="text_pole dbridge_npc_avatar" value="${escapeHtml(m.avatarUrl || '')}" placeholder="아바타 URL" style="flex:1" />
                    <div class="menu_button dbridge_npc_del" title="NPC 삭제" style="flex:0 0 auto">✕</div>
                </div>`).join('');
            npcBox = `
                <div class="dbridge_npcbox" style="width:100%;padding-left:1em">
                    <div class="dbridge_hint">메인 캐릭터 + NPC들의 단톡. NPC는 메인의 로어북/CHARM을 참고해 연기. 유저는 곁다리로 낌.</div>
                    ${rows}
                    <div class="menu_button dbridge_npc_add" title="NPC 추가" style="white-space:nowrap;margin-top:4px">＋ NPC</div>
                </div>`;
        }

        // 단체면 인물 목록(이름+아바타URL) 서브영역
        let groupBox = '';
        if (isGroup) {
            const mem = Array.isArray(conf.members) ? conf.members : [];
            const rows = mem.map((m, mi) => `
                <div class="dbridge_grpmem" data-mi="${mi}" style="display:flex;gap:6px;align-items:center;margin:3px 0">
                    <input type="text" class="text_pole dbridge_grp_name" value="${escapeHtml(m.name || '')}" placeholder="인물 이름" style="flex:0 0 30%" />
                    <input type="text" class="text_pole dbridge_grp_avatar" value="${escapeHtml(m.avatarUrl || '')}" placeholder="아바타 URL (imgur 등)" style="flex:1" />
                    <div class="menu_button dbridge_grp_del" title="인물 삭제" style="flex:0 0 auto">✕</div>
                </div>`).join('');
            groupBox = `
                <div class="dbridge_grpbox" style="width:100%;padding-left:1em">
                    <div class="dbridge_hint">첫 인물 이름 적고 🪄로 시트에서 자동 추출 → 각자 아바타 URL 입력</div>
                    ${rows}
                    <div style="display:flex;gap:6px;margin-top:4px">
                        <div class="menu_button dbridge_grp_extract" title="시트에서 인물 자동 추출" style="white-space:nowrap">🪄 자동추출</div>
                        <div class="menu_button dbridge_grp_add" title="인물 추가" style="white-space:nowrap">＋ 인물</div>
                    </div>
                </div>`;
        }

        const $row = $(`
            <div class="dbridge_row" data-channel="${escapeHtml(channelId)}">
                <span>채널</span>
                <select class="text_pole dbridge_row_channel">${ensureOpt}${chanOpts}</select>
                ${charField}
                <span>나(페르소나)</span>
                <select class="text_pole dbridge_row_persona">${ensurePersona}${personaOpts}</select>
                ${groupCheck}
                <div class="menu_button dbridge_row_del" title="삭제"><i class="fa-solid fa-trash"></i></div>
                ${groupBox}
                ${npcBox}
            </div>
        `);
        $list.append($row);
    }
}

// 화면 → state 동기화 (저장 직전 호출)
function syncFromDom() {
    state.botMode = $('#dbridge_botmode').val() === 'multi' ? 'multi' : 'single';
    state.connectionProfile = $('#dbridge_profile').val();
    state.imageProfile = $('#dbridge_imageprofile').val();
    state.language = $('#dbridge_lang').val();
    state.maxHistoryMessages = parseInt($('#dbridge_history').val(), 10) || 50;
    state.maxResponseTokens = parseInt($('#dbridge_tokens').val(), 10) || 1000;
    state.splitMessages = $('#dbridge_split').prop('checked');
    state.chatSlang = $('#dbridge_slang').prop('checked');
    state.proactive = {
        enabled: $('#dbridge_proactive').prop('checked'),
        photos: $('#dbridge_proactive_photos').prop('checked'),
        idleMinHours: parseFloat($('#dbridge_idlemin').val()) || 3,
        idleMaxHours: parseFloat($('#dbridge_idlemax').val()) || 8,
        activeHours: [
            parseInt($('#dbridge_active_start').val(), 10) || 0,
            parseInt($('#dbridge_active_end').val(), 10) || 23,
        ],
    };

    const multi = state.botMode === 'multi';

    if (multi) {
        // 멀티봇: 행마다 개별/단체. 빈 행도 유지(작성 중이므로)
        const members = [];
        $('#dbridge_member_list .dbridge_row').each(function () {
            const idx = parseInt($(this).attr('data-idx'), 10);
            const group = $(this).find('.dbridge_m_group').prop('checked');
            const persona = $(this).find('.dbridge_m_persona').val();
            const typed = ($(this).find('.dbridge_m_token').val() || '').trim();
            const m = {};
            if (group) {
                m.sheet = $(this).find('.dbridge_m_sheet').val() || '';
                m.name = ($(this).find('.dbridge_m_name').val() || '').trim();
            } else {
                m.character = $(this).find('.dbridge_m_char').val() || '';
            }
            if (persona) m.persona = persona;
            const ch = $(this).find('.dbridge_m_channel').val();
            if (ch) m.channels = [ch];
            const avatar = ($(this).find('.dbridge_m_avatar').val() || '').trim();
            if (avatar) m.avatarUrl = avatar;
            if (typed) { m.token = typed; m.tokenSaved = true; }
            else if (state.members[idx]?.tokenSaved) m.tokenSaved = true;
            members.push(m);
        });
        state.members = members;
    } else {
        const channels = {};
        $('#dbridge_channel_list .dbridge_row').each(function () {
            const chId = $(this).find('.dbridge_row_channel').val();
            const persona = $(this).find('.dbridge_row_persona').val();
            const isGroup = $(this).find('.dbridge_row_groupchk').prop('checked');
            const isNpc = $(this).find('.dbridge_row_npcchk').prop('checked');
            if (!chId) return;
            if (isGroup) {
                const sheet = $(this).find('.dbridge_row_sheet').val() || '';
                const members = [];
                $(this).find('.dbridge_grpmem').each(function () {
                    const name = ($(this).find('.dbridge_grp_name').val() || '').trim();
                    const avatarUrl = ($(this).find('.dbridge_grp_avatar').val() || '').trim();
                    if (name) members.push(avatarUrl ? { name, avatarUrl } : { name });
                });
                const entry = { group: true, sheet, members };
                if (persona) entry.persona = persona;
                channels[chId] = entry;
            } else if (isNpc) {
                const char = $(this).find('.dbridge_row_char').val();
                if (!char) return;
                const npcs = [];
                $(this).find('.dbridge_npcmem').each(function () {
                    const name = ($(this).find('.dbridge_npc_name').val() || '').trim();
                    const avatarUrl = ($(this).find('.dbridge_npc_avatar').val() || '').trim();
                    if (name) npcs.push(avatarUrl ? { name, avatarUrl } : { name });
                });
                const entry = { npcGroup: true, character: char, npcs };
                if (persona) entry.persona = persona;
                channels[chId] = entry;
            } else {
                const char = $(this).find('.dbridge_row_char').val();
                if (!char) return;
                const entry = { character: char };
                if (persona) entry.persona = persona;
                channels[chId] = entry;
            }
        });
        state.channels = channels;
    }
}

async function save() {
    syncFromDom();
    const $btn = $('#dbridge_save');
    $btn.prop('disabled', true).text('저장 중...');
    try {
        const payload = {
            botMode: state.botMode,
            connectionProfile: state.connectionProfile,
            imageProfile: state.imageProfile,
            language: state.language,
            maxHistoryMessages: state.maxHistoryMessages,
            maxResponseTokens: state.maxResponseTokens,
            stPath: state.stPath,
            splitMessages: state.splitMessages,
            chatSlang: state.chatSlang,
            proactive: state.proactive,
            channels: state.channels,
            members: state.members,
            movieToken: ($('#dbridge_movietoken').val() || '').trim(),
            openSub: { ...(state.openSub || {}), apiKey: ($('#dbridge_opensub').val() || '').trim() },
            liveVoice: $('#dbridge_livevoice').val() || 'Charon',
        };
        // 토큰류는 입력했을 때만 전송. 비우면 안 보냄 → 서버가 기존 유지(절대 안 날아감).
        const liveKey = ($('#dbridge_livekey').val() || '').trim();
        if (liveKey) payload.liveApiKey = liveKey;
        const mainTok = ($('#dbridge_token').val() || '').trim();
        if (mainTok) payload.discordToken = mainTok;
        const pbTok = ($('#dbridge_personabot').val() || '').trim();
        if (pbTok) payload.personaBotToken = pbTok;

        await apiPost('/config', payload);
        // 저장 성공 → 화면을 날리지 않고 state만 "저장됨" 상태로 갱신 후 다시 그림
        if (payload.discordToken) state.tokenSaved = true;
        if (payload.personaBotToken) state.personaBotSaved = true;
        if (payload.liveApiKey) state.liveKeySaved = true;
        for (const c of Object.values(state.channels)) {
            if (c.token) { c.tokenSaved = true; delete c.token; }
        }
        for (const m of state.members) {
            if (m.token) { m.tokenSaved = true; delete m.token; }
        }
        render();
        toastr.success('config.json 저장됨. 적용하려면 봇을 재시작하세요 (pm2 restart discord-bridge).', 'Discord Bridge');
    } catch (e) {
        toastr.error(e.message, 'Discord Bridge 저장 실패');
    } finally {
        $btn.prop('disabled', false).text('저장');
    }
}

// --- 유틸 ---
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- UI 주입 ---
const SETTINGS_HTML = `
<div class="discord-bridge-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>🤖 Discord Bridge</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="dbridge_statusbar">
                <span id="dbridge_status">⚪ 상태 확인 중...</span>
                <div class="dbridge_inline">
                    <div class="menu_button" id="dbridge_refresh"><i class="fa-solid fa-rotate"></i> </div>
                    <div class="menu_button" id="dbridge_restart"><i class="fa-solid fa-power-off"></i> </div>
                    <div class="menu_button" id="dbridge_update"><i class="fa-solid fa-download"></i> </div>
                    <div class="menu_button" id="dbridge_devupdate" style="display:none" title="개발(dev) 업데이트"><i class="fa-solid fa-flask"></i> dev</div>
                </div>
            </div>

            <details class="dbridge_changelog">
                <summary>📋 업데이트 내역</summary>
                <div class="dbridge_changelog_body">
                    <b>2026-07-05 — NPC 단톡</b>
                    <ul>
                        <li>채널 매핑에서 <b>"NPC그룹" 체크 + NPC 이름/아바타 입력</b> (그 채널은 1:1 그대로 유지됨)</li>
                        <li>그 갠톡 채널에서 <code>/npc create</code> → NPC들이 들어간 <b>파생 단톡 채널 자동 생성</b></li>
                        <li>갠톡↔NPC단톡 <b>기억·상태 공유</b> (갠톡에서 회의중이면 단톡에서도 회의중)</li>
                        <li>유저는 단톡의 곁다리 — 메인은 "네가 왜 여기서 말해?" 식으로 특별 반응</li>
                        <li>가끔 NPC가 메인 캐릭터 몰카를 선톡으로 공유 (선톡 사진 켜져 있을 때)</li>
                        <li><code>/npc add·remove·list·delete</code> 로 파생 단톡에서 NPC 관리</li>
                    </ul>
                    <b>이전 업데이트</b>
                    <ul>
                        <li>영화 같이보기 (크롬 확장 + <code>/movie</code>) — 넷플/디즈니/유튜브/쿠팡 자막 실시간 반응</li>
                        <li>이미지 전용 프로필 분리, OpenAI 호환 커스텀 URL, 잼민 프록시 라우팅</li>
                        <li>사람답게: 타이핑 감지 배칭(입력 중엔 기다림), 단톡 자유 티키타카, 갠톡 줄수 가변</li>
                        <li>세트: <code>/setup</code>(챗·롤플·요약 채널), <code>/mode</code> 이동+요약, [MEET] 자동 롤플 개장</li>
                        <li><code>/purge</code>·<code>/nuke</code>·수동삭제 히스토리 동기화, <code>/anniv</code> 기념일, <code>/lang</code> 채널별 언어</li>
                    </ul>
                </div>
            </details>

            <select id="dbridge_botmode" class="text_pole" style="display:none">
                <option value="single">단일봇</option>
                <option value="multi">멀티봇</option>
            </select>

            <div id="dbridge_single_box">
                <label>Discord 봇 토큰</label>
                <div class="dbridge_inline">
                    <input type="password" id="dbridge_token" class="text_pole" autocomplete="off" />
                    <div class="menu_button" id="dbridge_token_eye"><i class="fa-solid fa-eye"></i></div>
                </div>
            </div>

            <div id="dbridge_multi_box" style="display:none">
                <label>페르소나 전담봇 토큰 <span class="dbridge_hint">(내 메시지를 페르소나로 바꿔치기 전용)</span></label>
                <div class="dbridge_inline">
                    <input type="password" id="dbridge_personabot" class="text_pole" autocomplete="off" />
                </div>
                <div class="dbridge_hint">⚠ 이 봇에 "웹훅 관리 + 메시지 관리" 권한 필요. 비우면 기존 토큰 유지. 채널 봇 토큰은 아래에.</div>
            </div>

            <label>커넥션 프로필 (AI 백엔드)</label>
            <select id="dbridge_profile" class="text_pole"></select>

            <label>이미지 전용 프로필 <span class="dbridge_hint">(채팅이 클로드/잼민프록시일 때, 이미지 생성·사진읽기용 Gemini 키 프로필)</span></label>
            <select id="dbridge_imageprofile" class="text_pole"></select>
            <div class="dbridge_hint">이미지는 Gemini 키가 필요. 채팅 프로필에 Gemini 키 있으면 비워둬도 됨.</div>

            <div class="dbridge_grid2">
                <div>
                    <label>응답 언어</label>
                    <select id="dbridge_lang" class="text_pole"></select>
                </div>
                <div>
                    <label>최근 메시지 수</label>
                    <input type="number" id="dbridge_history" class="text_pole" min="1" />
                </div>
                <div>
                    <label>응답 토큰</label>
                    <input type="number" id="dbridge_tokens" class="text_pole" min="1" />
                </div>
            </div>

            <hr/>
            <!-- 단일봇: 채널↔캐릭터 매핑 -->
            <div id="dbridge_single_map">
                <div class="dbridge_section_head">
                    <label>채널 ↔ 캐릭터 매핑</label>
                    <div class="menu_button" id="dbridge_add_channel"><i class="fa-solid fa-plus"></i> </div>
                </div>
                <div class="dbridge_hint" id="dbridge_channels_note"></div>
                <div id="dbridge_channel_list"></div>
            </div>

            <!-- 멀티봇: 캐릭터(멤버) 목록. 봇 초대된 채널 어디서나 동작 -->
            <div id="dbridge_multi_map" style="display:none">
                <div class="dbridge_section_head">
                    <label>캐릭터(봇) 목록</label>
                    <div class="menu_button" id="dbridge_add_member"><i class="fa-solid fa-plus"></i> </div>
                </div>
                <div class="dbridge_hint">봇 초대된 채널 어디서나 그 캐릭터로 답합니다. 그룹채널에 여러 봇 = 단톡. 행마다 "단체" 체크하면 한 시트 속 한 인물로 설정.</div>
                <div id="dbridge_member_list"></div>
            </div>

            <hr/>
            <label>메시지 / 말투</label>
            <label class="checkbox_label dbridge_check">
                <input type="checkbox" id="dbridge_split" />
                <span>긴 답을 여러 메시지로 나눠 보내기 (실채팅 느낌)</span>
            </label>
            <label class="checkbox_label dbridge_check">
                <input type="checkbox" id="dbridge_slang" />
                <span>ㅋㅋ·ㅎㅎ·이모지 사용 허용</span>
            </label>

            <hr/>
            <label class="checkbox_label dbridge_check">
                <input type="checkbox" id="dbridge_proactive" />
                <span><b>틈틈이 선톡</b> — 한동안 조용하면 봇이 먼저 말 걸기</span>
            </label>
            <div id="dbridge_proactive_opts">
                <div class="dbridge_grid2">
                    <div>
                        <label>조용하면 최소(h)</label>
                        <input type="number" id="dbridge_idlemin" class="text_pole" min="0.1" step="0.1" />
                    </div>
                    <div>
                        <label>최대(h)</label>
                        <input type="number" id="dbridge_idlemax" class="text_pole" min="0.1" step="0.1" />
                    </div>
                    <div></div>
                </div>
                <div class="dbridge_grid2">
                    <div>
                        <label>활동 시작(시)</label>
                        <input type="number" id="dbridge_active_start" class="text_pole" min="0" max="23" />
                    </div>
                    <div>
                        <label>활동 종료(시)</label>
                        <input type="number" id="dbridge_active_end" class="text_pole" min="0" max="23" />
                    </div>
                    <div></div>
                </div>
                <label class="checkbox_label dbridge_check">
                    <input type="checkbox" id="dbridge_proactive_photos" />
                    <span>선톡에 가끔 사진 첨부 (⚠ 이미지 생성 비용 발생)</span>
                </label>
                <div class="dbridge_hint">변경 후 봇 재시작 필요.</div>
            </div>
            <div class="dbridge_hint">⏰ "8시에 깨워줘", "2시에 약속 리마인드 해줘" 같은 <b>특정 시각 알람은 봇한테 채팅으로 말하면</b> 알아서 그 시각에 연락합니다 (설정 불필요).</div>

            <hr/>
            <label>🎬 영화 같이보기 토큰 <span class="dbridge_hint">(크롬 확장에 똑같이 입력)</span></label>
            <div class="dbridge_inline">
                <input type="text" id="dbridge_movietoken" class="text_pole" autocomplete="off" placeholder="아무 긴 랜덤 문자열" />
                <div class="menu_button" id="dbridge_movietoken_gen" title="랜덤 생성"><i class="fa-solid fa-dice"></i></div>
            </div>
            <div class="dbridge_hint">넷플/유튜브/디즈니+ 같이보기용. 이 값과 크롬 확장의 토큰이 일치해야 합니다. 변경 후 봇·ST 재시작.</div>

            <label>📄 OpenSubtitles API 키 <span class="dbridge_hint">(모바일 /watch 자막 자동검색용)</span></label>
            <input type="text" id="dbridge_opensub" class="text_pole" autocomplete="off" placeholder="opensubtitles.com API Key (anonymous면 키만)" />
            <div class="dbridge_hint">opensubtitles.com → 가입 → Consumers → "Allow anonymous downloads" 켜고 키 발급. 비우면 .srt 파일 직접 첨부로만 가능. 변경 후 봇 재시작.</div>

            <label>📞 Gemini Live API 키 <span class="dbridge_hint">(실시간 음성통화 — 있으면 /call이 Live 모드로)</span></label>
            <div class="dbridge_inline">
                <input type="password" id="dbridge_livekey" class="text_pole" autocomplete="off" />
                <div class="menu_button" id="dbridge_livekey_eye"><i class="fa-solid fa-eye"></i></div>
            </div>
            <div class="dbridge_grid2">
                <div>
                    <label>Live 목소리</label>
                    <select id="dbridge_livevoice" class="text_pole">
                        <option value="Charon">Charon (남성 저음)</option>
                        <option value="Fenrir">Fenrir (남성 강함)</option>
                        <option value="Orus">Orus (남성)</option>
                        <option value="Puck">Puck (남성 밝음)</option>
                        <option value="Kore">Kore (여성)</option>
                        <option value="Aoede">Aoede (여성 밝음)</option>
                        <option value="Leda">Leda (여성 젊음)</option>
                        <option value="Zephyr">Zephyr (여성 차분)</option>
                    </select>
                </div>
            </div>
            <div class="dbridge_hint"><b>aistudio.google.com/apikey</b>에서 무료 키 발급 (결제등록 불필요). 키가 없으면 /call은 STT+TTS 모드(느림)로 동작. 변경 후 봇 재시작.</div>

            <hr/>
            <div class="menu_button menu_button_icon" id="dbridge_save"><i class="fa-solid fa-floppy-disk"></i> 저장</div>
            <div class="dbridge_hint">⚠ 토큰/채널 변경 후 봇을 재시작해야 적용됩니다 (pm2 restart discord-bridge).</div>
        </div>
    </div>
</div>
`;

jQuery(async () => {
    $('#extensions_settings2').append(SETTINGS_HTML);

    // 이벤트 바인딩
    $('#dbridge_refresh').on('click', () => {
        refreshStatus();
        refreshChannels();
    });
    $('#dbridge_restart').on('click', async () => {
        const $btn = $('#dbridge_restart');
        $btn.prop('disabled', true);
        try {
            await apiPost('/restart', {});
            toastr.success('봇 재시작 요청됨.', 'Discord Bridge');
            setTimeout(refreshStatus, 4000);
        } catch (e) {
            toastr.error(e.message, '재시작 실패 (pm2 확인)');
        } finally {
            $btn.prop('disabled', false);
        }
    });
    $('#dbridge_update').on('click', async () => {
        if (!confirm('최신 버전을 받아 적용할까요?\n(git pull → 설치 → 재배포 → 봇 재시작)')) return;
        const $btn = $('#dbridge_update');
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> ');
        try {
            const r = await apiPost('/update', {});
            toastr.success('업데이트 완료. 확장 변경은 브라우저 새로고침(F5), 플러그인 변경은 ST 재시작 후 적용됩니다.', 'Discord Bridge', { timeOut: 8000 });
            console.log('[DiscordBridge] update:', r.output);
            setTimeout(refreshStatus, 4000);
        } catch (e) {
            toastr.error(e.message, '업데이트 실패 (git remote/충돌 확인)');
        } finally {
            $btn.prop('disabled', false).html('<i class="fa-solid fa-download"></i> ');
        }
    });
    $('#dbridge_devupdate').on('click', async () => {
        // 비밀키 입력(브라우저에 기억). 서버가 키 일치할 때만 dev 받기 → 나만 작동
        let key = localStorage.getItem('dbridge_devkey') || '';
        key = prompt('개발(dev) 업데이트 키를 입력하세요:', key) || '';
        if (!key) return;
        localStorage.setItem('dbridge_devkey', key);
        const $btn = $('#dbridge_devupdate');
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> dev');
        try {
            const r = await apiPost('/dev-update', { key });
            toastr.success('dev 적용 완료. 확장 변경은 F5, 플러그인 변경은 ST 재시작 후 반영.', 'Discord Bridge (dev)', { timeOut: 8000 });
            console.log('[DiscordBridge] dev-update:', r.output);
            setTimeout(refreshStatus, 4000);
        } catch (e) {
            toastr.error(e.message, 'dev 업데이트 실패 (키/충돌 확인)');
        } finally {
            $btn.prop('disabled', false).html('<i class="fa-solid fa-flask"></i> dev');
        }
    });
    $('#dbridge_proactive').on('change', function () {
        $('#dbridge_proactive_opts').toggle($(this).prop('checked'));
    });
    $('#dbridge_token_eye').on('click', () => {
        const $t = $('#dbridge_token');
        $t.attr('type', $t.attr('type') === 'password' ? 'text' : 'password');
    });
    $('#dbridge_livekey_eye').on('click', () => {
        const $t = $('#dbridge_livekey');
        $t.attr('type', $t.attr('type') === 'password' ? 'text' : 'password');
    });
    // 영화 토큰 랜덤 생성
    $('#dbridge_movietoken_gen').on('click', () => {
        const rnd = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        $('#dbridge_movietoken').val((rnd() + rnd()).slice(0, 48));
    });
    // 봇 모드 전환: 입력 보존하고 모드에 맞게 다시 그림
    $('#dbridge_botmode').on('change', () => { syncFromDom(); render(); });
    $('#dbridge_add_channel').on('click', () => {
        const tempId = '__new__' + Date.now();
        state.channels[tempId] = { character: characters[0] || '' };
        renderChannelRows();
    });
    $('#dbridge_channel_list').on('click', '.dbridge_row_del', function () {
        $(this).closest('.dbridge_row').remove();
    });
    // 단일봇 채널 행: 단체(단톡) 토글
    $('#dbridge_channel_list').on('change', '.dbridge_row_groupchk', function () {
        syncFromDom();
        const chId = $(this).closest('.dbridge_row').find('.dbridge_row_channel').val();
        const c = state.channels[chId] || {};
        if ($(this).prop('checked')) {
            const mem = (c.members && c.members.length) ? c.members : [{ name: '', avatarUrl: '' }];
            state.channels[chId] = { group: true, sheet: c.sheet || '', members: mem, persona: c.persona };
        } else { state.channels[chId] = { character: c.character || (characters[0] || ''), persona: c.persona }; }
        renderChannelRows();
    });
    // NPC그룹 토글
    $('#dbridge_channel_list').on('change', '.dbridge_row_npcchk', function () {
        syncFromDom();
        const chId = $(this).closest('.dbridge_row').find('.dbridge_row_channel').val();
        const c = state.channels[chId] || {};
        if ($(this).prop('checked')) {
            const npcs = (c.npcs && c.npcs.length) ? c.npcs : [{ name: '', avatarUrl: '' }];
            state.channels[chId] = { npcGroup: true, character: c.character || (characters[0] || ''), npcs, persona: c.persona };
        } else { state.channels[chId] = { character: c.character || (characters[0] || ''), persona: c.persona }; }
        renderChannelRows();
    });
    $('#dbridge_channel_list').on('click', '.dbridge_npc_add', function () {
        syncFromDom();
        const chId = $(this).closest('.dbridge_row').find('.dbridge_row_channel').val();
        const c = state.channels[chId]; if (!c) return;
        c.npcs = c.npcs || []; c.npcs.push({ name: '', avatarUrl: '' });
        renderChannelRows();
    });
    $('#dbridge_channel_list').on('click', '.dbridge_npc_del', function () {
        syncFromDom();
        const chId = $(this).closest('.dbridge_row').find('.dbridge_row_channel').val();
        const mi = +$(this).closest('.dbridge_npcmem').data('mi');
        const c = state.channels[chId]; if (!c?.npcs) return;
        c.npcs.splice(mi, 1);
        renderChannelRows();
    });
    // 인물 추가/삭제
    $('#dbridge_channel_list').on('click', '.dbridge_grp_add', function () {
        syncFromDom();
        const chId = $(this).closest('.dbridge_row').find('.dbridge_row_channel').val();
        const c = state.channels[chId]; if (!c) return;
        (c.members = c.members || []).push({ name: '', avatarUrl: '' });
        renderChannelRows();
    });
    $('#dbridge_channel_list').on('click', '.dbridge_grp_del', function () {
        syncFromDom();
        const $row = $(this).closest('.dbridge_row');
        const chId = $row.find('.dbridge_row_channel').val();
        const mi = parseInt($(this).closest('.dbridge_grpmem').attr('data-mi'), 10);
        const c = state.channels[chId]; if (!c?.members) return;
        c.members.splice(mi, 1);
        renderChannelRows();
    });
    // 🪄 시트에서 인물 자동 추출 (첫 인물 이름 샘플)
    $('#dbridge_channel_list').on('click', '.dbridge_grp_extract', async function () {
        syncFromDom();
        const chId = $(this).closest('.dbridge_row').find('.dbridge_row_channel').val();
        const c = state.channels[chId]; if (!c?.group) return;
        if (!c.sheet) { toastr.warning('먼저 시트 카드를 고르세요.'); return; }
        const sample = (c.members?.[0]?.name || '').trim();
        if (!sample) { toastr.warning('첫 인물 이름을 한 명 적은 뒤 눌러주세요.'); return; }
        try {
            const res = await apiGet(`/sheet-members?card=${encodeURIComponent(c.sheet)}&sample=${encodeURIComponent(sample)}`);
            const names = res.names || [];
            if (names.length <= 1) { toastr.warning('다른 인물을 못 찾았어요. 수동으로 추가하세요.'); return; }
            // 기존 아바타URL 보존하며 이름 채우기
            const prev = {}; (c.members || []).forEach((m) => { if (m.name) prev[m.name] = m.avatarUrl || ''; });
            c.members = names.map((n) => ({ name: n, avatarUrl: prev[n] || '' }));
            renderChannelRows();
            toastr.success(`${names.length}명 추출: ${names.join(', ')}`, '단체 시트');
        } catch (e) { toastr.error(e.message, '추출 실패'); }
    });

    // --- 멀티봇: 멤버 추가/삭제 + 행 단위 단체 토글 ---
    $('#dbridge_add_member').on('click', () => {
        syncFromDom();
        state.members.push({ character: '' }); // 기본 개별
        render();
    });
    $('#dbridge_member_list').on('change', '.dbridge_m_group', function () {
        syncFromDom();
        const idx = parseInt($(this).closest('.dbridge_row').attr('data-idx'), 10);
        const m = state.members[idx]; if (!m) return;
        if ($(this).prop('checked')) { delete m.character; m.sheet = m.sheet || ''; m.name = m.name || ''; }
        else { delete m.sheet; delete m.name; m.character = m.character || ''; }
        render();
    });
    $('#dbridge_member_list').on('click', '.dbridge_m_del', function () {
        syncFromDom();
        const idx = parseInt($(this).closest('.dbridge_row').attr('data-idx'), 10);
        if (!Number.isNaN(idx)) state.members.splice(idx, 1);
        render();
    });
    // 같은 시트 인물 1개 추가 (수동)
    $('#dbridge_member_list').on('click', '.dbridge_m_addsame', function () {
        syncFromDom();
        const idx = parseInt($(this).closest('.dbridge_row').attr('data-idx'), 10);
        const m = state.members[idx]; if (!m) return;
        state.members.splice(idx + 1, 0, { sheet: m.sheet || '', name: '', persona: m.persona || '' });
        render();
    });
    // 🔄 시트 자동추출: 내가 적은 첫 인물 이름을 "샘플"로, 같은 패턴의 다른 이름들을 시트에서 찾음
    $('#dbridge_member_list').on('click', '.dbridge_m_extract', async function () {
        syncFromDom();
        const idx = parseInt($(this).closest('.dbridge_row').attr('data-idx'), 10);
        const m = state.members[idx]; if (!m) return;
        if (!m.sheet) { toastr.warning('먼저 시트 카드를 고르세요.'); return; }
        if (!m.name) { toastr.warning('첫 인물 이름을 한 명 적은 뒤 눌러주세요 (예: John Price).'); return; }
        try {
            const res = await apiGet(`/sheet-members?card=${encodeURIComponent(m.sheet)}&sample=${encodeURIComponent(m.name)}`);
            const names = res.names || [];
            if (names.length <= 1) { toastr.warning('같은 패턴의 다른 인물을 못 찾았어요. 수동으로 적어주세요.'); return; }
            const persona = m.persona || '';
            const rows = names.map((nm) => ({ sheet: m.sheet, name: nm, persona }));
            // 같은 시트 기존 행 제거 후 이 자리에 새로 삽입
            state.members = state.members.filter((x) => x.sheet !== m.sheet);
            state.members.splice(idx, 0, ...rows);
            render();
            toastr.success(`${names.length}명 추출: ${names.join(', ')}`, '단체 시트');
        } catch (e) {
            toastr.error(e.message, '시트 추출 실패');
        }
    });

    $('#dbridge_save').on('click', save);

    await loadAll();
});
