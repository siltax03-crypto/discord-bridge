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
    connectionProfile: '',
    language: 'ko',
    maxHistoryMessages: 50,
    maxResponseTokens: 1000,
    stPath: '',
    splitMessages: true,
    chatSlang: true,
    proactive: { enabled: false, idleMinHours: 3, idleMaxHours: 8, activeHours: [9, 23] },
    channels: {}, // { channelId: { character } }
};
let profiles = [];
let characters = [];
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
    try {
        const [cfgRes, profRes, charRes] = await Promise.all([
            apiGet('/config'),
            apiGet('/profiles'),
            apiGet('/characters'),
        ]);

        const c = cfgRes.config || {};
        const p = c.proactive || {};
        state = {
            discordToken: '',
            tokenSaved: !!cfgRes.hasToken,
            connectionProfile: c.connectionProfile || c.connectionProfileId || '',
            language: c.language || 'ko',
            maxHistoryMessages: c.maxHistoryMessages ?? 50,
            maxResponseTokens: c.maxResponseTokens ?? 1000,
            stPath: c.stPath || '',
            splitMessages: c.splitMessages !== false,
            chatSlang: c.chatSlang !== false,
            proactive: {
                enabled: !!p.enabled,
                idleMinHours: p.idleMinHours ?? 3,
                idleMaxHours: p.idleMaxHours ?? 8,
                activeHours: Array.isArray(p.activeHours) ? p.activeHours : [9, 23],
            },
            channels: c.channels || {},
        };
        profiles = profRes.profiles || [];
        characters = charRes.characters || [];

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
    // 토큰
    $('#dbridge_token').attr('placeholder', state.tokenSaved ? '•••••••• (저장됨)' : '디스코드 봇 토큰 입력');

    // 프로필 드롭다운
    const profOpts =
        '<option value="">(ST에서 선택된 프로필 사용)</option>' +
        optionList(profiles, state.connectionProfile, (p) => ({
            value: p.name,
            label: `${p.name}  (${p.api} / ${p.model})${p.selected ? '  ★' : ''}`,
        }));
    $('#dbridge_profile').html(profOpts);

    // 언어
    $('#dbridge_lang').html(optionList(LANGS, state.language, (l) => ({ value: l.value, label: l.label })));

    // 숫자
    $('#dbridge_history').val(state.maxHistoryMessages);
    $('#dbridge_tokens').val(state.maxResponseTokens);

    // 메시지/말투
    $('#dbridge_split').prop('checked', state.splitMessages);
    $('#dbridge_slang').prop('checked', state.chatSlang);

    // 선톡
    const p = state.proactive;
    $('#dbridge_proactive').prop('checked', p.enabled);
    $('#dbridge_idlemin').val(p.idleMinHours);
    $('#dbridge_idlemax').val(p.idleMaxHours);
    $('#dbridge_active_start').val(p.activeHours[0]);
    $('#dbridge_active_end').val(p.activeHours[1]);
    $('#dbridge_proactive_opts').toggle(p.enabled);

    renderChannelRows();
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

        const $row = $(`
            <div class="dbridge_row" data-channel="${escapeHtml(channelId)}">
                <span>채널</span>
                <select class="text_pole dbridge_row_channel">${ensureOpt}${chanOpts}</select>
                <span>캐릭터</span>
                <select class="text_pole dbridge_row_char">${ensureChar}${charOpts}</select>
                <div class="menu_button dbridge_row_del" title="삭제"><i class="fa-solid fa-trash"></i></div>
            </div>
        `);
        $list.append($row);
    }
}

// 화면 → state 동기화 (저장 직전 호출)
function syncFromDom() {
    const token = $('#dbridge_token').val();
    if (token) state.discordToken = token; // 비어있으면 기존 저장값 유지

    state.connectionProfile = $('#dbridge_profile').val();
    state.language = $('#dbridge_lang').val();
    state.maxHistoryMessages = parseInt($('#dbridge_history').val(), 10) || 50;
    state.maxResponseTokens = parseInt($('#dbridge_tokens').val(), 10) || 1000;
    state.splitMessages = $('#dbridge_split').prop('checked');
    state.chatSlang = $('#dbridge_slang').prop('checked');
    state.proactive = {
        enabled: $('#dbridge_proactive').prop('checked'),
        idleMinHours: parseInt($('#dbridge_idlemin').val(), 10) || 3,
        idleMaxHours: parseInt($('#dbridge_idlemax').val(), 10) || 8,
        activeHours: [
            parseInt($('#dbridge_active_start').val(), 10) || 0,
            parseInt($('#dbridge_active_end').val(), 10) || 23,
        ],
    };

    const channels = {};
    $('#dbridge_channel_list .dbridge_row').each(function () {
        const chId = $(this).find('.dbridge_row_channel').val();
        const char = $(this).find('.dbridge_row_char').val();
        if (chId && char) channels[chId] = { character: char };
    });
    state.channels = channels;
}

async function save() {
    syncFromDom();
    const $btn = $('#dbridge_save');
    $btn.prop('disabled', true).text('저장 중...');
    try {
        const payload = {
            discordToken: $('#dbridge_token').val() || '__SAVED__',
            connectionProfile: state.connectionProfile,
            language: state.language,
            maxHistoryMessages: state.maxHistoryMessages,
            maxResponseTokens: state.maxResponseTokens,
            stPath: state.stPath,
            splitMessages: state.splitMessages,
            chatSlang: state.chatSlang,
            proactive: state.proactive,
            channels: state.channels,
        };
        await apiPost('/config', payload);
        $('#dbridge_token').val(''); // 입력칸 비우고
        state.tokenSaved = state.tokenSaved || !!payload.discordToken;
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
                    <div class="menu_button" id="dbridge_refresh"><i class="fa-solid fa-rotate"></i> 새로고침</div>
                    <div class="menu_button" id="dbridge_restart"><i class="fa-solid fa-power-off"></i> 봇 재시작</div>
                    <div class="menu_button" id="dbridge_update"><i class="fa-solid fa-download"></i> 업데이트</div>
                </div>
            </div>

            <label>Discord 봇 토큰</label>
            <div class="dbridge_inline">
                <input type="password" id="dbridge_token" class="text_pole" autocomplete="off" />
                <div class="menu_button" id="dbridge_token_eye"><i class="fa-solid fa-eye"></i></div>
            </div>

            <label>커넥션 프로필 (AI 백엔드)</label>
            <select id="dbridge_profile" class="text_pole"></select>

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
            <div class="dbridge_section_head">
                <label>채널 ↔ 캐릭터 매핑</label>
                <div class="menu_button" id="dbridge_add_channel"><i class="fa-solid fa-plus"></i> 추가</div>
            </div>
            <div class="dbridge_hint" id="dbridge_channels_note"></div>
            <div id="dbridge_channel_list"></div>

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
                        <input type="number" id="dbridge_idlemin" class="text_pole" min="1" />
                    </div>
                    <div>
                        <label>최대(h)</label>
                        <input type="number" id="dbridge_idlemax" class="text_pole" min="1" />
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
                <div class="dbridge_hint">변경 후 봇 재시작 필요.</div>
            </div>
            <div class="dbridge_hint">⏰ "8시에 깨워줘", "2시에 약속 리마인드 해줘" 같은 <b>특정 시각 알람은 봇한테 채팅으로 말하면</b> 알아서 그 시각에 연락합니다 (설정 불필요).</div>

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
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> 업데이트 중...');
        try {
            const r = await apiPost('/update', {});
            toastr.success('업데이트 완료. 확장 변경은 브라우저 새로고침(F5), 플러그인 변경은 ST 재시작 후 적용됩니다.', 'Discord Bridge', { timeOut: 8000 });
            console.log('[DiscordBridge] update:', r.output);
            setTimeout(refreshStatus, 4000);
        } catch (e) {
            toastr.error(e.message, '업데이트 실패 (git remote/충돌 확인)');
        } finally {
            $btn.prop('disabled', false).html('<i class="fa-solid fa-download"></i> 업데이트');
        }
    });
    $('#dbridge_proactive').on('change', function () {
        $('#dbridge_proactive_opts').toggle($(this).prop('checked'));
    });
    $('#dbridge_token_eye').on('click', () => {
        const $t = $('#dbridge_token');
        $t.attr('type', $t.attr('type') === 'password' ? 'text' : 'password');
    });
    $('#dbridge_add_channel').on('click', () => {
        // 빈 행 추가: 임시 키
        const tempId = '__new__' + Date.now();
        state.channels[tempId] = { character: characters[0] || '' };
        renderChannelRows();
    });
    $('#dbridge_channel_list').on('click', '.dbridge_row_del', function () {
        $(this).closest('.dbridge_row').remove();
    });
    $('#dbridge_save').on('click', save);

    await loadAll();
});
