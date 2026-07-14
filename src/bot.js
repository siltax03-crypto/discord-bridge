import { Client, GatewayIntentBits, Events, AttachmentBuilder, SlashCommandBuilder, MessageFlags, ActivityType, ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import STReader from './st-reader.js';
import ContextBuilder from './context-builder.js';
import AIClient from './ai-client.js';
import ChatHistory from './chat-history.js';
import ImageGen from './image-gen.js';
import Modes from './modes.js';
import Langs from './langs.js';
import Reminders from './reminders.js';
import Notes from './notes.js';
import Anniv from './anniversaries.js';
import Away from './away.js';
import Sets from './sets.js';
import Movie from './movie.js';
import Srt from './srt.js';
import Subtitles from './subtitles.js';
import NpcGroups from './npc-groups.js';
import VoiceCall from './voice-call.js';
import GeminiLive from './voice-live.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let config = {};
const clients = [];              // 기동된 모든 Client
const channelClients = {};       // 단일봇: { channelId: client }
const clientMember = new Map();  // 멀티봇: client → member({character|sheet,name,token,persona})
let personaClient = null;        // 멀티봇: 페르소나 웹훅/삭제 전담 봇
let primaryClient = null;        // 슬래시 명령 등록/대표 client
// 채널별 웹훅 캐시: { channelId: webhookObject }
const webhookCache = {};
// 채널별 캐릭터 데이터 캐시
const characterCache = {};
// 페르소나 프록시가 직접 지운 메시지 ID (삭제 동기화에서 무시하기 위함)
const proxiedMessageIds = new Set();
// 채널별 "답 없으면 재촉" 타이머 (유저가 답하면 취소)
const followupTimers = {};
// 세트별 "만남 예약" 타이머/정보: { rpChannelId: timer }, { rpChannelId: {fireAt, note, character} }
const meetTimers = {};
const meetInfo = {};
// 영화 같이보기 세션 (한 번에 하나)
let movieSession = null;
// "영화 보자" 버튼이 채널별로 들고 있을 제목: { channelId: title }
const pendingMovie = {};
// 채널별 답장 배칭: 연달아 온 메시지를 모아 한 번만 답 (중복답 방지 + 사람 같은 타이밍)
const pendingReplies = {};
const BATCH_WINDOW_MS = 3500; // 마지막 메시지 후 이만큼 더 안 오면 답
// 유저가 입력 중인 채널: { channelId: 언제까지 타이핑 중으로 볼지(ms) } — 입력 중이면 답을 미룸
const typingUntil = {};
// 단톡 배칭: { channelId: {timer, firstQueuedAt, chCfg} }, 생성 잠금
const groupTimers = {};
const groupGenerating = {};
// 채널별 생성 잠금: 한 채널에서 답 생성은 한 번에 하나만 (생성 중 온 메시지가 별도 답으로 새지 않게)
const generating = {};
// 멀티봇 그룹챗: 한 유저 메시지를 여러 멤버봇이 보므로, 저장/프록시는 한 번만 (메시지ID 기준)
const intakeDone = new Set();

const Bot = {
    async start(cfg) {
        config = cfg;

        // /setup 으로 만든 세트(데이터 파일)를 채널 매핑에 병합 (config.json은 플러그인 소유라 안 건드림)
        this._mergeSets();
        // /npc 로 만든 NPC그룹 채널 병합
        for (const [id, g] of NpcGroups.entries()) {
            config.channels[id] = { npcGroup: true, character: g.character, npcs: g.npcs || [] };
        }

        // 영화 같이보기 수신 서버 (localhost, ST 플러그인이 프록시)
        if (cfg.movieEnabled !== false) {
            Movie.init({
                port: cfg.moviePort || 8788,
                token: cfg.movieToken || '',
                onStart: (a) => this._movieStart(a),
                onSub: (a) => this._movieSub(a),
                onEnd: (a) => this._movieEnd(a),
            });
        }

        if (cfg.botMode === 'multi') {
            // 멀티봇: 멤버(캐릭터)마다 봇 1개. 채널 지정 없음 — 봇이 초대된 채널 어디서든 그 캐릭터로 동작.
            const members = (cfg.members || []).filter((m) => m && m.token && !m.token.includes('여기에'));
            if (members.length === 0) throw new Error('멀티봇 모드인데 멤버에 봇 토큰이 하나도 없습니다.');
            // 첫 봇만 명령 등록 담당. 전부 병렬 로그인(순차보다 N배 빠름).
            await Promise.all(members.map(async (m, i) => {
                const cl = await this._startClient(m.token, [], { commands: i === 0, member: m });
                clientMember.set(cl, m);
                if (i === 0) primaryClient = cl;
            }));

            // 페르소나 전담 봇 (웹훅/메시지삭제 전담). 같이 병렬로.
            if (cfg.personaBotToken && !cfg.personaBotToken.includes('여기에')) {
                personaClient = await this._startClient(cfg.personaBotToken, [], { persona: true });
            }
            console.log(`[Bot] 멀티봇: 멤버봇 ${members.length}개${personaClient ? ' + 페르소나봇 1개' : ''}`);
        } else {
            // 단일봇: 토큰 1개가 모든 채널 담당 (기존 동작)
            const cl = await this._startClient(cfg.discordToken, Object.keys(cfg.channels || {}), { commands: true });
            primaryClient = cl;
            console.log('[Bot] 단일봇 모드');
        }
    },

    // --- Client 1개 기동 ---
    async _startClient(token, channelIds, { commands = false, persona = false, member = null } = {}) {
        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageTyping,
                GatewayIntentBits.DirectMessageTyping,
                GatewayIntentBits.GuildVoiceStates,
            ],
        });

        for (const chId of channelIds) channelClients[chId] = client;

        client.once(Events.ClientReady, async (c) => {
            const who = persona ? ' (페르소나 전담)' : member ? ` = ${member.name || member.character}` : ` / 채널 ${channelIds.length}개`;
            console.log(`[Bot] 로그인: ${c.user.tag}${who}`);
            try { c.user.setPresence({ status: 'online' }); } catch { /* 무시 */ }
            if (commands) {
                await this._registerCommands(client);
            } else {
                // 명령 담당이 아닌 봇(페르소나봇·나머지 멤버봇)은 자기 슬래시 명령을 비워
                // 유저가 그 봇 명령을 골라 "응답 안 함" 타임아웃 나는 걸 방지
                try { for (const g of c.guilds.cache.values()) await g.commands.set([]); } catch { /* 무시 */ }
            }
        });

        if (!persona) {
            client.on(Events.MessageCreate, (message) => this._onMessage(message, client));
            client.on(Events.MessageDelete, (message) => this._onMessageDelete(message, client));
            client.on(Events.InteractionCreate, (interaction) => this._onInteraction(interaction, client));
            client.on(Events.ChannelDelete, (ch) => this._onChannelDelete(ch));
            client.on(Events.VoiceStateUpdate, (o, n) => this._onVoiceState(o, n));
            // 유저가 입력 중이면 답을 미룬다 (여러 줄 연달아 칠 때 끊지 않게)
            client.on(Events.TypingStart, (typing) => {
                if (typing.user?.bot) return;
                typingUntil[typing.channel.id] = Date.now() + (config.typingGraceMs || 6000);
            });
        } else {
            // 페르소나 전담봇: 웹훅 단톡(토큰 없는 멤버만 있는 채널)에선 이 봇이 메시지를 받아 그룹 처리
            client.on(Events.MessageCreate, (message) => this._onPersonaMessage(message));
        }

        await client.login(token);
        clients.push(client);
        return client;
    },

    // --- 슬래시 명령어 등록 (서버별로 즉시 반영) ---
    async _registerCommands(client) {
        const commands = [
            new SlashCommandBuilder()
                .setName('setup')
                .setDescription('지금 이 챗 채널을 기준으로 롤플/요약 채널을 만들어 세트로 묶기')
                .addStringOption((o) =>
                    o.setName('character').setDescription('캐릭터 카드 이름 (비우면 이 채널에 연결된 캐릭터 사용)').setRequired(false)),
            new SlashCommandBuilder()
                .setName('unsetup')
                .setDescription('세트 해제: 롤플/요약 채널 삭제, 챗 채널은 일반 채널로 유지'),
            new SlashCommandBuilder()
                .setName('npc')
                .setDescription('이 캐릭터의 NPC 단톡 (갠톡에서 파생된 별도 채널)')
                .addSubcommand((s) => s.setName('create').setDescription('NPC 단톡 채널 새로 만들기 (갠톡에서 실행하면 그 캐릭터 자동)')
                    .addStringOption((o) => o.setName('character').setDescription('메인 캐릭터 카드 이름 (갠톡이 아닌 곳에서 실행 시 필수)')))
                .addSubcommand((s) => s.setName('add').setDescription('NPC 추가 (NPC 단톡 채널에서)')
                    .addStringOption((o) => o.setName('name').setDescription('NPC 이름 (예: Captain America)').setRequired(true))
                    .addStringOption((o) => o.setName('avatar').setDescription('아바타 이미지 URL')))
                .addSubcommand((s) => s.setName('remove').setDescription('NPC 삭제')
                    .addStringOption((o) => o.setName('name').setDescription('삭제할 NPC 이름').setRequired(true)))
                .addSubcommand((s) => s.setName('list').setDescription('NPC 목록'))
                .addSubcommand((s) => s.setName('delete').setDescription('이 NPC 단톡 채널 해제/삭제')),
            new SlashCommandBuilder()
                .setName('call')
                .setDescription('캐릭터와 음성 통화 (먼저 음성채널에 들어간 뒤 갠톡 채널에서 실행)')
                .addSubcommand((s) => s.setName('start').setDescription('통화 시작')
                    .addStringOption((o) => o.setName('voice').setDescription('목소리 (기본: 한국어 남성)')
                        .addChoices(
                            { name: '🇰🇷 남성 (InJoon)', value: 'ko-KR-InJoonNeural' },
                            { name: '🇰🇷 남성 멀티링구얼 (Hyunsu)', value: 'ko-KR-HyunsuMultilingualNeural' },
                            { name: '🇰🇷 여성 (SunHi)', value: 'ko-KR-SunHiNeural' },
                            { name: '🇬🇧 남성 브리티시 (Ryan)', value: 'en-GB-RyanNeural' },
                            { name: '🇺🇸 남성 (Guy)', value: 'en-US-GuyNeural' },
                            { name: '🇺🇸 여성 (Jenny)', value: 'en-US-JennyNeural' },
                        )))
                .addSubcommand((s) => s.setName('end').setDescription('통화 끊기')),
            new SlashCommandBuilder()
                .setName('movie')
                .setDescription('영화 같이보기 (보통은 브라우저 확장으로 시작/종료)')
                .addStringOption((o) => o.setName('action').setDescription('end = 강제 종료, status = 상태')
                    .addChoices({ name: '종료(end)', value: 'end' }, { name: '상태(status)', value: 'status' })),
            new SlashCommandBuilder()
                .setName('watch')
                .setDescription('자막(.srt)으로 영화 같이보기 — 모바일/넷플 등 어디서든')
                .addSubcommand((s) => s.setName('start').setDescription('같이보기 시작 (영화방 생성)')
                    .addStringOption((o) => o.setName('character').setDescription('누구랑 볼지 (캐릭터/시트 이름)').setRequired(true))
                    .addStringOption((o) => o.setName('title').setDescription('영화 제목 (자막 자동검색용). 자막파일 첨부하면 생략 가능'))
                    .addAttachmentOption((o) => o.setName('srt').setDescription('자막 .srt 파일 (직접 올릴 때)'))
                    .addBooleanOption((o) => o.setName('group').setDescription('단톡으로 보기 (그 시트 멤버 전원)')))
                .addSubcommand((s) => s.setName('go').setDescription('지금 재생 시작! (폰에서 재생 누를 때)'))
                .addSubcommand((s) => s.setName('sync').setDescription('방금 들은 대사로 위치 맞춤')
                    .addStringOption((o) => o.setName('line').setDescription('방금 들린 대사 한 줄').setRequired(true)))
                .addSubcommand((s) => s.setName('pause').setDescription('일시정지'))
                .addSubcommand((s) => s.setName('resume').setDescription('다시 재생'))
                .addSubcommand((s) => s.setName('end').setDescription('같이보기 종료 (리뷰 남김)')),
            new SlashCommandBuilder()
                .setName('mode')
                .setDescription('대화 모드 전환 (채팅 ↔ 롤플)')
                .addStringOption((o) =>
                    o
                        .setName('type')
                        .setDescription('chat = 디스코드 채팅, rp = 문자 롤플')
                        .setRequired(true)
                        .addChoices(
                            { name: '채팅 (chat)', value: 'chat' },
                            { name: '롤플 (rp)', value: 'rp' },
                        ),
                ),
            new SlashCommandBuilder()
                .setName('nsfw')
                .setDescription('이 채널 연령제한(NSFW) 켜기/끄기'),
            new SlashCommandBuilder()
                .setName('lang')
                .setDescription('이 채널 응답 언어 (한국어 ↔ English)')
                .addStringOption((o) =>
                    o.setName('lang').setDescription('ko = 한국어, en = English').setRequired(true)
                        .addChoices({ name: '한국어 (ko)', value: 'ko' }, { name: 'English (en)', value: 'en' })),
            new SlashCommandBuilder()
                .setName('clear')
                .setDescription('이 채널의 대화 기록 초기화 (봇 기억만)'),
            new SlashCommandBuilder()
                .setName('purge')
                .setDescription('디코 메시지 최근 N개 삭제 + 봇 기억에서도 제거 (14일 이내만)')
                .addIntegerOption((o) =>
                    o.setName('count').setDescription('지울 개수 (1~100, 기본 20)').setRequired(false)),
            new SlashCommandBuilder()
                .setName('nuke')
                .setDescription('채널 통째 비우기: 복제 후 원본 삭제 (14일 제한 없음, 채널 ID 바뀜)'),
            new SlashCommandBuilder()
                .setName('retry')
                .setDescription('마지막 메시지에 다시 답하기 (오류로 답이 안 왔을 때)'),
            new SlashCommandBuilder()
                .setName('note')
                .setDescription('작가노트(추가 지시) 관리')
                .addSubcommand((s) =>
                    s.setName('add').setDescription('노트 추가').addStringOption((o) =>
                        o.setName('text').setDescription('추가할 지시 내용').setRequired(true)))
                .addSubcommand((s) => s.setName('list').setDescription('노트 목록 보기'))
                .addSubcommand((s) =>
                    s.setName('del').setDescription('노트 삭제').addIntegerOption((o) =>
                        o.setName('index').setDescription('목록 번호 (1부터)').setRequired(true)))
                .addSubcommand((s) => s.setName('clear').setDescription('노트 전체 삭제')),
            new SlashCommandBuilder()
                .setName('anniv')
                .setDescription('기념일/D-day 관리 (사귄 날·생일 등 — 캐릭터가 챙김)')
                .addSubcommand((s) =>
                    s.setName('add').setDescription('기념일 추가')
                        .addStringOption((o) => o.setName('label').setDescription('이름 예: 사귄 날, 생일').setRequired(true))
                        .addStringOption((o) => o.setName('date').setDescription('날짜 YYYY-MM-DD').setRequired(true))
                        .addStringOption((o) => o.setName('type').setDescription('since=그날부터 D+N / yearly=매년반복')
                            .addChoices({ name: 'D-day 카운트 (사귄날·만난날)', value: 'since' }, { name: '매년 반복 (생일·기념일)', value: 'yearly' })))
                .addSubcommand((s) => s.setName('list').setDescription('기념일 목록/현황 보기'))
                .addSubcommand((s) =>
                    s.setName('del').setDescription('기념일 삭제').addIntegerOption((o) =>
                        o.setName('index').setDescription('목록 번호 (1부터)').setRequired(true))),
            new SlashCommandBuilder()
                .setName('info')
                .setDescription('이 채널에 주입되는 정보 보기 (캐릭터/페르소나/메모리 등)'),
            new SlashCommandBuilder()
                .setName('pic')
                .setDescription('내 페르소나 셀카를 생성해서 보내기 (⚠ 이미지 생성 비용)')
                .addStringOption((o) =>
                    o.setName('description').setDescription('어떤 사진? 예: 어색하게 웃는 셀카').setRequired(true)),
            new SlashCommandBuilder()
                .setName('reminders')
                .setDescription('예약된 리마인더 관리')
                .addSubcommand((s) => s.setName('list').setDescription('리마인더 목록 보기'))
                .addSubcommand((s) =>
                    s.setName('del').setDescription('리마인더 삭제').addIntegerOption((o) =>
                        o.setName('index').setDescription('목록 번호 (1부터)').setRequired(true)))
                .addSubcommand((s) => s.setName('clear').setDescription('리마인더 전체 삭제')),
        ].map((c) => c.toJSON());

        try {
            for (const guild of client.guilds.cache.values()) {
                await guild.commands.set(commands);
            }
            console.log(`[Bot] 슬래시 명령어 등록: ${client.guilds.cache.size}개 서버`);
        } catch (e) {
            console.error('[Bot] 슬래시 명령어 등록 실패:', e.message);
        }
    },

    // --- 슬래시 명령어 처리 ---
    async _onInteraction(interaction, client) {
        // 영화 컨트롤 버튼/모달
        if (interaction.isButton() && interaction.customId?.startsWith('watch_')) {
            return this._handleWatchButton(interaction);
        }
        if (interaction.isModalSubmit() && interaction.customId === 'watch_sync_modal') {
            return this._handleWatchSyncModal(interaction);
        }
        if (interaction.isModalSubmit() && interaction.customId === 'watch_open_modal') {
            return this._handleWatchOpenModal(interaction);
        }
        if (!interaction.isChatInputCommand()) return;
        const channelId = interaction.channelId;
        const eph = { flags: MessageFlags.Ephemeral };
        const cmd = interaction.commandName;

        // /setup 은 아직 매핑 안 된 채널에서도 실행 가능 (세트를 만드는 명령이므로)
        if (cmd === 'setup') {
            return this._handleSetup(interaction);
        }
        if (cmd === 'unsetup') {
            return this._handleUnsetup(interaction);
        }
        if (cmd === 'npc') {
            return this._handleNpc(interaction);
        }
        if (cmd === 'movie') {
            const action = interaction.options.getString('action') || 'status';
            if (action === 'end') {
                await interaction.reply({ content: '🎬 영화 종료 처리 중...', ...eph });
                const r = await this._movieEnd().catch((e) => ({ error: e.message }));
                return interaction.editReply(r?.error ? `⚠️ ${r.error}` : '🎬 영화를 종료하고 리뷰를 남겼어요.');
            }
            // status
            return interaction.reply({ content: movieSession ? `🎬 "${movieSession.movie}" 보는 중 → <#${movieSession.channelId}>` : '진행 중인 영화가 없어요. 브라우저 확장에서 "같이보기 시작"으로 시작하세요.', ...eph });
        }

        if (cmd === 'watch') {
            return this._handleWatch(interaction, eph);
        }

        // 단일봇만 채널 매핑 검사 (멀티봇은 봇 초대된 채널 어디서나 동작)
        if (config.botMode !== 'multi' && !config.channels[channelId]) {
            return interaction.reply({ content: '이 채널은 캐릭터와 매핑돼 있지 않아요.', ...eph });
        }

        if (cmd === 'mode') {
            return this._handleModeSwitch(interaction, channelId, eph);
        }

        if (cmd === 'call') {
            return this._handleCall(interaction, channelId, eph);
        }

        if (cmd === 'nsfw') {
            const ch = interaction.channel;
            const me = interaction.guild?.members.me;
            if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
                return interaction.reply({ content: '⚠️ 봇에 "채널 관리(Manage Channels)" 권한이 필요해요. (또는 채널 편집 → 연령 제한 채널 토글로 직접 켜도 돼요)', ...eph });
            }
            try {
                const next = !ch.nsfw;
                await ch.setNSFW(next);
                return interaction.reply({ content: next ? '🔞 이 채널을 연령제한(NSFW)으로 켰어요.' : '이 채널 연령제한을 껐어요.', ...eph });
            } catch (e) {
                return interaction.reply({ content: `⚠️ 실패: ${e.message}`, ...eph });
            }
        }

        if (cmd === 'lang') {
            const lang = interaction.options.getString('lang');
            Langs.set(channelId, lang);
            const label = lang === 'en' ? '🇺🇸 English' : '🇰🇷 한국어';
            return interaction.reply({ content: `${label}(으)로 전환했어요. 다음 답변부터 바로 적용돼요.`, ...eph });
        }

        if (cmd === 'clear') {
            ChatHistory.clear(channelId);
            return interaction.reply({ content: '🧹 대화 기록을 초기화했어요.', ...eph });
        }

        if (cmd === 'purge') {
            return this._handlePurge(interaction, channelId, eph);
        }

        if (cmd === 'nuke') {
            return this._handleNuke(interaction, channelId, eph);
        }

        if (cmd === 'retry') {
            // 마지막이 봇 응답이면 지우고 사용자 마지막 메시지에 다시 답한다
            ChatHistory.removeLastAssistantMessage(channelId);
            await interaction.reply({ content: '🔄 다시 답하는 중...', ...eph });
            try {
                const userName = interaction.member?.displayName || interaction.user.username;
                const ok = await this._respond(interaction.channel, channelId, { userName });
                await interaction.editReply(ok ? '✅ 다시 답했어요.' : '⚠️ 또 실패했어요. 잠시 후 다시 시도해주세요.');
            } catch (e) {
                await interaction.editReply(`⚠️ 오류: ${e.message?.substring(0, 100)}`);
            }
            return;
        }

        if (cmd === 'note') {
            const sub = interaction.options.getSubcommand();
            if (sub === 'add') {
                Notes.add(channelId, interaction.options.getString('text'));
                return interaction.reply({ content: '📝 작가노트를 추가했어요. 다음 답변부터 반영됩니다.', ...eph });
            }
            if (sub === 'list') {
                const arr = Notes.list(channelId);
                const body = arr.length
                    ? arr.map((n, i) => `${i + 1}. ${n}`).join('\n')
                    : '(작가노트 없음)';
                return interaction.reply({ content: `📝 작가노트\n${body}`, ...eph });
            }
            if (sub === 'del') {
                const idx = interaction.options.getInteger('index');
                const ok = Notes.remove(channelId, idx - 1);
                return interaction.reply({ content: ok ? `🗑 ${idx}번 노트를 삭제했어요.` : '⚠️ 그 번호의 노트가 없어요.', ...eph });
            }
            if (sub === 'clear') {
                Notes.clear(channelId);
                return interaction.reply({ content: '🗑 작가노트를 전부 삭제했어요.', ...eph });
            }
        }

        if (cmd === 'anniv') {
            const sub = interaction.options.getSubcommand();
            const tz = config.timezone || 'Asia/Seoul';
            if (sub === 'add') {
                const label = interaction.options.getString('label');
                const date = interaction.options.getString('date');
                const type = interaction.options.getString('type') || 'since';
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                    return interaction.reply({ content: '⚠️ 날짜는 YYYY-MM-DD 형식으로 적어주세요. 예: 2025-03-14', ...eph });
                }
                Anniv.add(channelId, label, date, type);
                return interaction.reply({ content: `💝 "${label}" (${date}, ${type === 'yearly' ? '매년 반복' : 'D-day'}) 등록했어요. 캐릭터가 이제 챙길 거예요.`, ...eph });
            }
            if (sub === 'list') {
                const st = Anniv.status(channelId, tz);
                const body = st.length
                    ? st.map((a, i) => `${i + 1}. ${a.text}`).join('\n')
                    : '(등록된 기념일 없음 — /anniv add 로 추가)';
                return interaction.reply({ content: `💝 기념일/D-day\n${body}`, ...eph });
            }
            if (sub === 'del') {
                const idx = interaction.options.getInteger('index');
                const ok = Anniv.remove(channelId, idx - 1);
                return interaction.reply({ content: ok ? `🗑 ${idx}번 기념일을 삭제했어요.` : '⚠️ 그 번호의 기념일이 없어요.', ...eph });
            }
        }

        if (cmd === 'info') {
            const character = this._getCharacter(channelId);
            if (!character) return interaction.reply({ content: '⚠️ 캐릭터 로드 실패', ...eph });
            const charName = character.name || '?';
            const descLen = (character.description || '').length;

            const personaName = this._getPersonaName(channelId);
            const personaText = personaName ? STReader.getPersonaByName(personaName) : STReader.getPersonaDescription();

            const mode = Modes.get(channelId);
            const charBook = STReader.getCharacterBook(character).length;
            const worldName = STReader.getCharacterWorldName(character);
            const worldEntries = STReader.getWorldInfo(worldName).length;

            const charId = character.avatar?.replace(/\.[^/.]+$/, '') || charName;
            const charm = STReader.getCharmMemory(charId);
            const charmCount = charm?.memories?.length || 0;

            // 세트/만남 예약 정보
            const setFound = Sets.findByChannel(channelId);
            let setLine = '';
            let meetLine = '';
            if (setFound) {
                const s = setFound.set;
                setLine = `• 세트(${setFound.role}): 💬<#${s.chat}> 🎭<#${s.rp}> 📝<#${s.summary}>`;
                const mi = meetInfo[s.rp];
                if (mi) {
                    const left = Math.max(0, Math.round((mi.fireAt - Date.now()) / 60000));
                    meetLine = `• 만남 예약: 🚪 ${left}분 후 롤플 채널에서 시작${mi.note ? ` (${mi.note})` : ''}`;
                } else {
                    meetLine = '• 만남 예약: 없음';
                }
            }

            const lines = [
                '**📋 채널 주입 정보**',
                `• 캐릭터: ${charName} (설명 ${descLen}자)`,
                `• 페르소나: ${personaName || '(기본)'} ${personaText ? `(${personaText.length}자)` : '(없음)'}`,
                `• 모드: ${mode === 'rp' ? '🎭 롤플' : '💬 채팅'}`,
                `• 언어: ${Langs.get(channelId, config.language || 'ko') === 'en' ? '🇺🇸 English' : '🇰🇷 한국어'}`,
                `• 로어북: 캐릭터북 ${charBook}개 + 월드"${worldName || '-'}" ${worldEntries}개`,
                `• CHARM 메모리: ${charmCount}개`,
                `• 작가노트: ${Notes.list(channelId).length}개`,
                `• 기념일: ${Anniv.list(channelId).length}개`,
                `• 리마인더: ${Reminders.listForChannel(channelId).length}개`,
                `• 상태: ${Away.isAway(channelId) ? '🔇 잠수 중 (응답 안 함)' : '🟢 응답 중'}`,
                `• 프로필: ${AIClient.getProfile()?.name || '?'}`,
                `• 프리셋: ${AIClient.getProfile()?.preset || '없음'} ${mode === 'rp' ? '(RP 주입중)' : '(채팅 모드라 미주입)'}`,
                setLine,
                meetLine,
            ].filter(Boolean);
            return interaction.reply({ content: lines.join('\n'), ...eph });
        }

        if (cmd === 'pic') {
            const promptText = interaction.options.getString('description');
            const personaName = this._getPersonaName(channelId);
            if (!personaName) {
                return interaction.reply({ content: '이 채널에 페르소나(나)가 설정 안 됐어요. ST 확장에서 채널에 페르소나를 지정하면 그 얼굴로 셀카가 생성돼요.', ...eph });
            }
            const avatarPath = STReader.getPersonaAvatarPath(personaName);
            if (!avatarPath) {
                return interaction.reply({ content: `페르소나 "${personaName}"의 아바타 이미지를 못 찾았어요. ST 페르소나에 사진이 있어야 해요.`, ...eph });
            }
            await interaction.reply({ content: '📸 셀카 생성 중...', ...eph });
            try {
                const desc = STReader.getPersonaByName(personaName);
                const buffer = await ImageGen.generateForPersona(promptText, avatarPath, desc);
                if (!buffer) return interaction.editReply('⚠️ 사진 생성 실패.');

                const webhook = await this._getNamedWebhook(interaction.channel, `bridge-persona-${personaName}`, avatarPath);
                const attachment = new AttachmentBuilder(buffer, { name: 'selfie.png' });
                let sent = null;
                if (webhook) sent = await webhook.send({ username: personaName, files: [attachment], wait: true });
                else await interaction.channel.send({ files: [attachment] });

                // 히스토리에 기록(연속성용) + 생성한 셀카를 비전으로 넘겨 캐릭터가 진짜 보게
                ChatHistory.addMessage(channelId, 'user', `(셀카를 보냈다: ${promptText})`, personaName);
                const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
                await interaction.editReply('📸 보냈어요.');
                this._queueReply(interaction.channel, channelId, { userName: personaName, reactTarget: sent, imageBase64: dataUrl });
            } catch (e) {
                await interaction.editReply(`⚠️ 오류: ${e.message?.substring(0, 150)}`);
            }
            return;
        }

        if (cmd === 'reminders') {
            const sub = interaction.options.getSubcommand();
            if (sub === 'list') {
                const arr = Reminders.listForChannel(channelId);
                const body = arr.length
                    ? arr.map((r, i) => `${i + 1}. [${Reminders.formatTime(r.fireAt)}] ${r.text}`).join('\n')
                    : '(예약된 리마인더 없음)';
                return interaction.reply({ content: `⏰ 리마인더\n${body}`, ...eph });
            }
            if (sub === 'del') {
                const idx = interaction.options.getInteger('index');
                const removed = Reminders.removeByIndex(channelId, idx - 1);
                return interaction.reply({
                    content: removed ? `🗑 [${Reminders.formatTime(removed.fireAt)}] 리마인더를 삭제했어요.` : '⚠️ 그 번호의 리마인더가 없어요.',
                    ...eph,
                });
            }
            if (sub === 'clear') {
                const n = Reminders.clearChannel(channelId);
                return interaction.reply({ content: `🗑 리마인더 ${n}개를 전부 삭제했어요.`, ...eph });
            }
        }
    },

    // --- 이름별 웹훅 가져오기/생성 (캐릭터·페르소나 공용) ---
    // --- 세트(카테고리+3채널) 매핑을 채널 설정에 병합 ---
    _mergeSets() {
        config.channels = config.channels || {};
        for (const s of Sets.list()) {
            if (s.chat && !config.channels[s.chat]) config.channels[s.chat] = { character: s.character };
            if (s.rp && !config.channels[s.rp]) config.channels[s.rp] = { character: s.character };
            if (s.summary) config.channels[s.summary] = { character: s.character, summaryOnly: true };
            if (s.chat) Modes.set(s.chat, 'chat');
            if (s.rp) Modes.set(s.rp, 'rp');
        }
    },

    // 채널이 디코에서 삭제되면 세트/매핑 정리 (다음 /setup이 깨끗하게 다시 만들 수 있게)
    _onChannelDelete(ch) {
        const id = ch?.id;
        if (!id) return;
        const found = Sets.findByChannel(id);
        if (found) {
            const s = found.set;
            if (found.role === 'chat') {
                // 챗 채널이 사라짐 = 세트 자체가 의미 없음 → 전체 정리
                for (const cid of [s.chat, s.rp, s.summary]) if (cid) delete config.channels[cid];
                Sets.remove(s);
                console.log(`[Bot] 챗 채널 삭제 → "${s.character}" 세트 전체 정리`);
            } else {
                // 롤플/요약만 사라짐 → 세트만 해제하고 챗 매핑은 살림 (일반 채널로 유지)
                delete config.channels[id];
                Sets.remove(s);
                console.log(`[Bot] ${found.role} 채널 삭제 → "${s.character}" 세트 해제(챗 <#${s.chat}>는 유지)`);
            }
        } else if (config.channels[id]) {
            delete config.channels[id];
        }
    },

    // 이 채널이 세트의 chat/rp면, 반대편에서 넘어온 요약을 주입용으로 반환
    _crossSummariesFor(channelId) {
        const found = Sets.findByChannel(channelId);
        if (!found || found.role === 'summary') return [];
        return Sets.recentSummaries(found.set.character, 6);
    },

    // 반대편 채널의 최근 원본 대화 꼬리 (챗→롤플: 챗 10개 / 롤플→챗: 롤플 3개)
    _crossRecentFor(channelId) {
        const found = Sets.findByChannel(channelId);
        if (!found || found.role === 'summary') return null;
        const otherId = found.role === 'rp' ? found.set.chat : found.set.rp;
        const from = found.role === 'rp' ? 'chat' : 'rp';
        const n = found.role === 'rp' ? 10 : 3; // 롤플에 있을 땐 챗 10개, 챗에 있을 땐 롤플 3개
        const msgs = ChatHistory.getMessages(otherId, n);
        if (!msgs.length) return null;
        const lines = msgs.map((m) => `${m.role === 'user' ? 'User' : (m.author || 'Character')}: ${typeof m.content === 'string' ? m.content : ''}`);
        return { from, lines };
    },

    // --- /purge: 디코 메시지 최근 N개 삭제 + 히스토리 동기화 ---
    async _handlePurge(interaction, channelId, eph) {
        const ch = interaction.channel;
        const me = interaction.guild?.members.me;
        if (!me || !ch?.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
            return interaction.reply({ content: '⚠️ 봇에 "메시지 관리(Manage Messages)" 권한이 필요해요.', ...eph });
        }
        const n = Math.min(Math.max(interaction.options.getInteger('count') || 20, 1), 100);
        await interaction.reply({ content: `🧹 최근 ${n}개 삭제 중...`, ...eph });
        try {
            const fetched = await ch.messages.fetch({ limit: n });
            const deleted = await ch.bulkDelete(fetched, true); // true = 14일 넘은 건 건너뜀
            let synced = 0;
            for (const m of deleted.values()) {
                const c = (m.content || '').trim();
                if (c && ChatHistory.removeByContent(channelId, c)) synced++;
            }
            const old = n - deleted.size;
            return interaction.editReply(`🧹 디코 ${deleted.size}개 삭제 + 기억 ${synced}개 정리 완료.${old > 0 ? `\n※ ${old}개는 14일이 지나 일괄삭제가 안 돼요 (개별 삭제만 가능).` : ''}`);
        } catch (e) {
            console.error('[Purge] 실패:', e);
            return interaction.editReply(`⚠️ 실패: ${e.message}`);
        }
    },

    // --- /nuke: 채널 복제 후 원본 삭제 (전부 비움). 매핑/세트/상태 새 채널로 이전, 기억은 초기화 ---
    async _handleNuke(interaction, channelId, eph) {
        const ch = interaction.channel;
        const me = interaction.guild?.members.me;
        if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.reply({ content: '⚠️ 봇에 "채널 관리(Manage Channels)" 권한이 필요해요.', ...eph });
        }
        await interaction.reply({ content: '💣 채널 비우는 중... (복제 후 원본 삭제)', ...eph });
        try {
            const clone = await ch.clone();
            try { await clone.setPosition(ch.position); } catch { /* 무시 */ }
            const newId = clone.id;
            this._migrateChannel(channelId, newId, interaction.client);
            ChatHistory.clear(channelId); // 비우기이므로 기억도 초기화 (새 채널은 빈 상태로 시작)
            await ch.delete('nuke').catch(() => {});
            await clone.send('💣 채널을 깨끗하게 비웠어요.').catch(() => {});
            return interaction.editReply(`💣 완료 → <#${newId}>`).catch(() => {});
        } catch (e) {
            console.error('[Nuke] 실패:', e);
            return interaction.editReply(`⚠️ 실패: ${e.message}`).catch(() => {});
        }
    },

    // 채널 ID가 바뀔 때(nuke) 봇 상태를 새 ID로 이전
    _migrateChannel(oldId, newId, client) {
        if (config.channels[oldId]) { config.channels[newId] = config.channels[oldId]; delete config.channels[oldId]; }
        if (channelClients[oldId]) { channelClients[newId] = channelClients[oldId]; delete channelClients[oldId]; }
        if (client) channelClients[newId] = client;
        Modes.rename?.(oldId, newId);
        Langs.rename?.(oldId, newId);
        Notes.rename?.(oldId, newId);
        Anniv.rename?.(oldId, newId);
        Reminders.renameChannel?.(oldId, newId);
        Sets.renameChannel?.(oldId, newId);
        for (const k of Object.keys(webhookCache)) if (k.startsWith(`${oldId}:`)) delete webhookCache[k];
    },

    // --- /setup: 지금 이 챗 채널을 챗으로 두고, 롤플/요약만 새로 만들어 세트로 묶기 ---
    async _handleSetup(interaction) {
        const eph = { flags: MessageFlags.Ephemeral };
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: '서버 채널 안에서 실행해주세요.', ...eph });

        const chatId = interaction.channelId;
        // 캐릭터: 옵션 우선, 없으면 이 채널에 연결된 캐릭터
        const charName = ((interaction.options.getString('character') || config.channels[chatId]?.character) || '').trim();
        if (!charName) {
            return interaction.reply({ content: '⚠️ 이 채널에 연결된 캐릭터가 없어요. character 옵션에 캐릭터 이름을 적거나, ST 확장에서 이 채널을 캐릭터에 연결한 뒤 다시 실행하세요.', ...eph });
        }
        const card = this._loadCharacterByName(charName);
        if (!card) return interaction.reply({ content: `⚠️ "${charName}" 캐릭터 카드를 못 찾았어요. ST 캐릭터 이름 그대로 적어주세요.`, ...eph });

        // 채널이 아직 살아있는지 확인 (유저가 디코에서 지웠을 수 있음)
        const alive = async (id) => !!(id && await guild.channels.fetch(id).catch(() => null));

        // 이 채널 또는 캐릭터로 기존 세트가 있으면: 채널이 다 살아있으면 막고, 하나라도 죽었으면 정리 후 재생성
        const existing = Sets.findByChannel(chatId)?.set || Sets.findByCharacter(charName);
        if (existing) {
            const [c, r, s] = await Promise.all([alive(existing.chat), alive(existing.rp), alive(existing.summary)]);
            if (c && r && s) {
                return interaction.reply({ content: `이미 "${existing.character}" 세트가 있어요:\n💬 <#${existing.chat}>  🎭 <#${existing.rp}>  📝 <#${existing.summary}>`, ...eph });
            }
            // 깨진 세트 정리 (삭제된 채널 매핑도 제거)
            for (const id of [existing.chat, existing.rp, existing.summary]) {
                if (id && id !== chatId) delete config.channels[id];
            }
            Sets.remove(existing);
            console.log(`[Setup] 깨진 세트 정리: ${existing.character}`);
        }

        const me = guild.members.me;
        if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.reply({ content: '⚠️ 봇에 "채널 관리(Manage Channels)" 권한이 없어요. 서버 설정 → 역할에서 켜주세요.', ...eph });
        }

        await interaction.reply({ content: '🔧 롤플/요약 채널 만드는 중...', ...eph });
        try {
            const everyone = guild.roles.everyone.id;
            // 비공개(나+봇만): 롤플/요약 채널
            const priv = [
                { id: everyone, deny: [PermissionFlagsBits.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageWebhooks] },
            ];

            // 카테고리: 챗 채널이 이미 같은 이름 카테고리에 있으면 재사용, 없으면 생성
            let category = interaction.channel.parent;
            if (!category || category.name !== charName) {
                category = await guild.channels.create({ name: charName, type: ChannelType.GuildCategory });
            }
            // 기존 챗 채널을 카테고리 안으로 이동 (같은 채널·ST연결·히스토리 그대로, 보기만 정리)
            try { await interaction.channel.setParent(category.id, { lockPermissions: false }); } catch (e) { console.warn('[Setup] 챗 채널 이동 실패(무시):', e.message); }

            // 카테고리 안에 이미 '롤플'/'요약' 채널이 있으면 재사용, 없으면 생성 (중복 방지)
            const kids = category.children?.cache;
            const findChild = (name) => kids?.find((c) => c.name === name && c.type === ChannelType.GuildText) || null;
            const rp = findChild('롤플')
                || await guild.channels.create({ name: '롤플', type: ChannelType.GuildText, parent: category.id, permissionOverwrites: priv, nsfw: true });
            const summary = findChild('요약')
                || await guild.channels.create({ name: '요약', type: ChannelType.GuildText, parent: category.id, permissionOverwrites: priv, nsfw: true });

            config.channels = config.channels || {};
            config.channels[chatId] = { ...(config.channels[chatId] || {}), character: charName };
            config.channels[rp.id] = { character: charName };
            config.channels[summary.id] = { character: charName, summaryOnly: true };
            channelClients[rp.id] = channelClients[summary.id] = interaction.client;
            Modes.set(chatId, 'chat');
            Modes.set(rp.id, 'rp');
            Sets.add({ character: charName, guildId: guild.id, categoryId: category.id, chat: chatId, rp: rp.id, summary: summary.id });

            await summary.send(`📝 **${charName} 요약**\n챗↔롤플 전환 때마다 무슨 얘기를 했는지 자동 기록돼요.`).catch(() => {});
            await rp.send('🎭 롤플 채널이에요. 채팅으로 돌아가려면 `/mode chat`').catch(() => {});

            return interaction.editReply(`✅ "${charName}" 세트 완료! (챗은 기존 <#${chatId}> 그대로)\n💬 <#${chatId}>  🎭 <#${rp.id}> (비공개·🔞)  📝 <#${summary.id}> (비공개·🔞)`);
        } catch (e) {
            console.error('[Setup] 실패:', e);
            return interaction.editReply(`⚠️ 생성 실패: ${e.message}`);
        }
    },

    // --- /unsetup: 세트 해제. 롤플/요약 채널 삭제, 챗은 일반 채널로 유지 ---
    async _handleUnsetup(interaction) {
        const eph = { flags: MessageFlags.Ephemeral };
        const guild = interaction.guild;
        const found = Sets.findByChannel(interaction.channelId);
        if (!found) {
            return interaction.reply({ content: '이 채널은 세트가 아니에요. 세트의 챗/롤플/요약 채널 중 한 곳에서 실행하세요.', ...eph });
        }
        const set = found.set;
        const me = guild?.members.me;
        await interaction.reply({ content: '🧹 세트 해제 중...', ...eph });
        try {
            // 만남 예약 정리
            if (meetTimers[set.rp]) { clearTimeout(meetTimers[set.rp]); delete meetTimers[set.rp]; }
            delete meetInfo[set.rp];

            // ★ 채널을 지우기 전에 먼저 세트/매핑을 제거한다.
            //   (안 그러면 채널 삭제 이벤트가 아직 살아있는 세트를 보고 챗 매핑까지 지워버림)
            Sets.remove(set);
            for (const id of [set.rp, set.summary]) {
                if (!id) continue;
                delete config.channels[id];
                ChatHistory.clear(id);
            }
            // 챗 매핑은 유지. 챗 채널은 카테고리에서 빼서 일반 위치로.
            try { const cc = await interaction.client.channels.fetch(set.chat).catch(() => null); if (cc) await cc.setParent(null, { lockPermissions: false }); } catch { /* 무시 */ }

            // 이제 롤플/요약 채널 실제 삭제
            for (const id of [set.rp, set.summary]) {
                if (!id) continue;
                try { const ch = await interaction.client.channels.fetch(id).catch(() => null); if (ch) await ch.delete('unsetup'); } catch { /* 무시 */ }
            }
            // 카테고리 비었으면 삭제
            try {
                const cat = await interaction.client.channels.fetch(set.categoryId).catch(() => null);
                if (cat && cat.children?.cache?.size === 0) await cat.delete('unsetup');
            } catch { /* 무시 */ }

            return interaction.editReply(`🧹 "${set.character}" 세트를 해제했어요. 챗 채널 <#${set.chat}>은 일반 채널로 유지돼요.`);
        } catch (e) {
            console.error('[Unsetup] 실패:', e);
            return interaction.editReply(`⚠️ 해제 실패: ${e.message}`);
        }
    },

    // --- /npc: 갠톡에서 파생된 NPC 단톡 채널 생성/관리 ---
    async _handleNpc(interaction) {
        const eph = { flags: MessageFlags.Ephemeral };
        const sub = interaction.options.getSubcommand();
        const ch = interaction.channelId;
        const guild = interaction.guild;

        if (sub === 'create') {
            // 메인 캐릭터: 옵션 > 이 채널에 매핑된 캐릭터. npcGroup 플래그가 켜져 있어도 character만 있으면 인정.
            const chCfg = config.channels[ch] || {};
            const charName = (interaction.options.getString('character') || '').trim() || chCfg.character || '';
            if (!charName) {
                return interaction.reply({ content: '⚠️ 메인 캐릭터를 못 정했어요. 캐릭터가 매핑된 채널에서 실행하거나 `/npc create character:카드이름` 으로 지정하세요.', ...eph });
            }
            // 확장에서 이 채널에 적어둔 NPC 로스터를 새 단톡으로 그대로 복사
            const roster = (Array.isArray(chCfg.npcs) ? chCfg.npcs : [])
                .filter((n) => n && n.name)
                .map((n) => (n.avatarUrl ? { name: n.name, avatarUrl: n.avatarUrl } : { name: n.name }));
            // 이 채널이 그 캐릭터의 채널이면 연동 소스로 기록하고, 1:1로 되돌린다(이 세션 한정).
            const srcChannel = chCfg.character === charName ? ch : null;
            const me = guild?.members.me;
            if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
                return interaction.reply({ content: '⚠️ 봇에 "채널 관리" 권한이 필요해요.', ...eph });
            }
            await interaction.reply({ content: `🔧 "${charName}" NPC 단톡 만드는 중...`, ...eph });
            try {
                // 이 채널이 속한 카테고리에 만들기 (없으면 카테고리 없이)
                const parent = interaction.channel?.parentId || null;
                const chName = this._sanitizeChannelName(`${charName}-npc단톡`);
                const newCh = await guild.channels.create({ name: chName, type: ChannelType.GuildText, parent });
                config.channels[newCh.id] = { npcGroup: true, character: charName, npcs: roster };
                channelClients[newCh.id] = interaction.client;
                Modes.set(newCh.id, 'chat');
                NpcGroups.add(newCh.id, { character: charName, npcs: roster, guildId: guild.id, srcChannel });
                // 소스 채널(#ado)은 NPC그룹 체크가 켜져 있어도 npcgroups.json에 없으므로 계속 1:1로 동작함 → 그대로 둔다.
                const rosterMsg = roster.length ? ` NPC ${roster.map((n) => n.name).join(', ')} 자동 등록됨.` : ' `/npc add`로 NPC를 넣어줘.';
                const linkNote = srcChannel ? ` ${charName}은 여기서도 <#${srcChannel}>(1:1)의 기억을 이어가요.` : ` ${charName}의 갠톡 기억과 자동으로 연동돼요.`;
                await newCh.send(`👥 **${charName}의 NPC 단톡**${rosterMsg}${linkNote}`).catch(() => {});
                return interaction.editReply(`✅ 생성! → <#${newCh.id}>${roster.length ? ` (NPC ${roster.length}명 등록됨)` : ' — `/npc add`로 NPC 추가'}\n<#${ch}> 는 그대로 1:1로 유지돼. NPC 로스터는 확장에서 계속 관리하면 되고, 다시 \`/npc create\` 하면 반영돼.`);
            } catch (e) {
                console.error('[NPC] 생성 실패:', e);
                return interaction.editReply(`⚠️ 실패: ${e.message}`);
            }
        }

        // add/remove/list/delete — /npc create로 만든 실제 NPC 단톡 채널에서만
        const g = NpcGroups.get(ch);
        if (!g) return interaction.reply({ content: '⚠️ `/npc create`로 만든 NPC 단톡 채널에서 실행하세요. (1:1 채널의 NPC 로스터는 확장 설정에서 관리)', ...eph });

        if (sub === 'add') {
            const name = interaction.options.getString('name').trim();
            const avatar = (interaction.options.getString('avatar') || '').trim();
            const npcs = (g.npcs || []).filter((n) => n.name.toLowerCase() !== name.toLowerCase());
            npcs.push(avatar ? { name, avatarUrl: avatar } : { name });
            NpcGroups.setNpcs(ch, npcs);
            if (config.channels[ch]) config.channels[ch].npcs = npcs;
            return interaction.reply({ content: `➕ NPC "${name}" 추가${avatar ? ' (아바타 O)' : ' (아바타 없음 — 얼굴은 기본)'}. 현재: ${npcs.map((n) => n.name).join(', ')}`, ...eph });
        }
        if (sub === 'remove') {
            const name = interaction.options.getString('name').trim();
            const npcs = (g.npcs || []).filter((n) => n.name.toLowerCase() !== name.toLowerCase());
            NpcGroups.setNpcs(ch, npcs);
            if (config.channels[ch]) config.channels[ch].npcs = npcs;
            return interaction.reply({ content: `🗑 "${name}" 제거. 남은 NPC: ${npcs.map((n) => n.name).join(', ') || '(없음)'}`, ...eph });
        }
        if (sub === 'list') {
            const npcs = g.npcs || [];
            return interaction.reply({ content: `👥 **${g.character}의 NPC 단톡**\nNPC: ${npcs.map((n) => `${n.name}${n.avatarUrl ? '🖼' : ''}`).join(', ') || '(아직 없음 — /npc add)'}`, ...eph });
        }
        if (sub === 'delete') {
            NpcGroups.remove(ch);
            delete config.channels[ch];
            await interaction.reply({ content: '🗑 이 NPC 단톡을 해제했어요. (채널은 직접 지워도 됨)', ...eph });
            try { const cc = await interaction.client.channels.fetch(ch).catch(() => null); if (cc) await cc.delete('npc delete'); } catch { /* 무시 */ }
            return;
        }
    },

    // --- /call: 음성채널에서 캐릭터와 통화 (무료 스택: Gemini STT + edge-tts) ---
    async _handleCall(interaction, channelId, eph) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'end') {
            const ok = VoiceCall.end(channelId, '사용자가 끊음');
            return interaction.reply({ content: ok ? '📞 통화를 끊었어요.' : '진행 중인 통화가 없어요.', ...eph });
        }
        // start
        const chCfg = config.channels[channelId] || {};
        if (chCfg.group || chCfg.npcGroup || chCfg.summaryOnly || chCfg.movie) {
            return interaction.reply({ content: '⚠️ 통화는 캐릭터 1:1 채널에서만 돼요.', ...eph });
        }
        const character = this._getCharacter(channelId);
        if (!character) return interaction.reply({ content: '⚠️ 이 채널에 연결된 캐릭터가 없어요.', ...eph });
        if (VoiceCall.active(channelId)) return interaction.reply({ content: '이미 통화 중이에요. `/call end`로 먼저 끊어요.', ...eph });
        const me = interaction.guild.members.me;
        let vc = interaction.member?.voice?.channel;
        let createdVc = false;
        if (!vc) {
            // 유저가 음성채널에 없으면 통화용 음성채널 자동 생성 (끊으면 자동 삭제)
            if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
                return interaction.reply({ content: '⚠️ 음성채널에 먼저 들어가거나, 봇에 "채널 관리" 권한(통화 채널 자동 생성용)을 주세요.', ...eph });
            }
            try {
                vc = await interaction.guild.channels.create({
                    name: this._sanitizeChannelName(`📞${character.name}`),
                    type: ChannelType.GuildVoice,
                    parent: interaction.channel?.parentId || null,
                });
                createdVc = true;
            } catch (e) {
                return interaction.reply({ content: `⚠️ 통화 채널 생성 실패: ${e.message}`, ...eph });
            }
        }
        const perms = vc.permissionsFor(me);
        if (!perms?.has(PermissionFlagsBits.Connect) || !perms.has(PermissionFlagsBits.Speak)) {
            if (createdVc) vc.delete().catch(() => {});
            return interaction.reply({ content: '⚠️ 봇에 그 음성채널의 "연결"과 "말하기" 권한이 필요해요.', ...eph });
        }
        const lang = Langs.get(channelId, config.language || 'ko');
        const voiceName = interaction.options.getString('voice') || chCfg.callVoice || config.callVoice
            || (lang === 'en' ? 'en-US-GuyNeural' : 'ko-KR-InJoonNeural');
        const userName = interaction.member?.displayName || interaction.user.username;

        // Gemini Live(실시간): Vertex 키(이미지/채팅 프로필) 또는 AI Studio 키가 있으면 켜짐
        const useLive = !!this._liveAuth();
        await interaction.reply({ content: `📞 ${character.name} 연결 중... (${vc.name}${useLive ? ' · Live' : ''})`, ...eph });

        // Live 모드: 음성↔음성 실시간. 캐릭터 컨텍스트는 시스템 프롬프트로 주입.
        let liveClient = null;
        const liveHooks = useLive ? {
            onUserSpeakStart: () => liveClient?.activityStart(),
            onUserAudioChunk: (pcm) => liveClient?.sendAudio(pcm),
            onUserSpeakEnd: () => liveClient?.activityEnd(),
        } : null;

        let session;
        try {
            session = await VoiceCall.start({
                voiceChannel: vc,
                textChannel: interaction.channel,
                channelId,
                userId: interaction.user.id,
                voiceName,
                character,
                userName,
                live: liveHooks,
                onUtterance: (wav) => this._onCallUtterance(channelId, character, userName, wav),
                onEnd: (reason) => {
                    interaction.channel.send(`📞 통화 종료${reason ? ` — ${reason}` : ''}`).catch(() => {});
                    if (createdVc) vc.delete('통화 종료').catch(() => {});
                },
            });
            if (useLive) {
                liveClient = await this._startLiveClient(channelId, character, userName);
                session.liveClient = liveClient;
            }
        } catch (e) {
            console.error('[Call] 시작 실패:', e);
            VoiceCall.end(channelId, '');
            if (createdVc) vc.delete().catch(() => {});
            return interaction.editReply(`⚠️ 연결 실패: ${e.message}`);
        }
        const greet = () => {
            if (useLive) liveClient?.sendText('(The user just called you on the phone and you picked up. Greet them first — short and natural, matching your current mood/situation and time of day.)');
            else this._callGenerate(channelId, character, userName, true).catch((e) => console.warn('[Call] 인사 생성 오류:', e.message));
        };
        session.greet = greet;
        if (createdVc) {
            // 유저가 아직 밖 — 들어오면(_onVoiceState) 캐릭터가 받음. 3분 내 안 들어오면 취소.
            session.joinTimer = setTimeout(() => {
                if (VoiceCall.active(channelId) && !session.greeted) VoiceCall.end(channelId, '안 받아서 끊음');
            }, 180_000);
            return interaction.editReply(`📞 전화 왔어요! <#${vc.id}> 들어오면 ${character.name}이(가) 받아요. (3분 내)`);
        }
        await interaction.editReply(`📞 연결됐어요!${useLive ? ' (Live — 실시간)' : ''} 그냥 말하면 돼요. 끊을 땐 \`/call end\` 또는 음성채널에서 나가기.`);
        // 캐릭터가 먼저 전화 받는 인사
        session.greeted = true;
        greet();
    },

    // Live 인증 결정: Vertex 기본 (이미지 전용 프로필 > Gemini 채팅 프로필), 없으면 AI Studio 키. 다 없으면 null.
    _liveAuth() {
        const isGem = (p) => !!p?.apiKey && (/vertex|google|makersuite/.test(p.api || '') || (p.model || '').includes('gemini'));
        const imgP = AIClient.getImageProfile();
        const chatP = AIClient.getProfile();
        const vp = isGem(imgP) ? imgP : (isGem(chatP) ? chatP : null);
        if (vp) return { vertex: true, apiKey: vp.apiKey };
        if (config.liveApiKey) return { vertex: false, apiKey: config.liveApiKey };
        return null;
    },

    // Gemini Live 클라이언트 생성 + 오디오/자막 배선
    async _startLiveClient(channelId, character, userName) {
        const personaName = this._getPersonaName(channelId);
        const personaText = personaName ? STReader.getPersonaByName(personaName) : '';
        const effUserName = personaName || userName;
        const sys = ContextBuilder.build(character, {
            userName: effUserName,
            language: Langs.get(channelId, config.language || 'ko'),
            mode: 'chat',
            chatSlang: config.chatSlang !== false,
            timezone: config.timezone || 'Asia/Seoul',
            notes: Notes.list(channelId),
            annivStatus: Anniv.status(channelId, config.timezone || 'Asia/Seoul'),
            personaText,
        }) + this._npcLinkedNote(channelId) + this._callNote(effUserName)
            + '\n- You are on a REAL-TIME voice line: speak immediately and briefly, like a real phone call.'
            + (config.liveStyle
                ? `\n- VOICE ACTING — deliver every line in this manner: ${config.liveStyle}`
                : '\n- VOICE ACTING: derive your vocal delivery entirely from your character sheet and the CURRENT situation/mood — tone, pace, energy, accent, laughs, sighs, verbal tics. Sound like the character actually talking on the phone right now (sleepy at 3am, hyped, annoyed, teasing — whatever fits the moment), never like a narrator reading lines.');

        // 직전 대화 꼬리도 얹어줌 (통화가 채팅 맥락을 이어가게)
        const recent = ChatHistory.getMessages(channelId, 12)
            .map((m) => `${m.role === 'user' ? effUserName : (m.author || character.name)}: ${typeof m.content === 'string' ? m.content : ''}`)
            .join('\n');
        const sysFull = recent ? `${sys}\n\n[RECENT CHAT — right before this call]\n${recent}` : sys;

        let userBuf = '';
        let modelBuf = '';

        // RVC 변환 (Modal): Live 오디오를 ~2초 세그먼트로 잘라 변환 서버에 보내고, 순서대로 재생
        const rvcBase = (config.rvcUrl || '').trim().replace(/\/+$/, '');
        // 목소리: 채널별(channels[id].rvcVoice) > 전역(config.rvcVoice) > 서버 기본
        const rvcVoice = config.channels[channelId]?.rvcVoice || config.rvcVoice || '';
        let segBuf = []; let segBytes = 0; let playChain = Promise.resolve();
        const SEG_BYTES = 24000 * 2 * 2; // 24kHz 16bit mono 2초
        const flushSeg = () => {
            if (!segBytes) return;
            const pcm = Buffer.concat(segBuf); segBuf = []; segBytes = 0;
            const converted = this._rvcConvert(rvcBase, pcm, rvcVoice).catch((e) => { console.warn('[RVC] 변환 실패(원음 재생):', e.message); return pcm; });
            playChain = playChain.then(async () => {
                const out = await converted;
                if (VoiceCall.active(channelId)) VoiceCall.playPcm24(channelId, out);
            }).catch(() => {});
        };

        // 인증: 기본 Vertex(이미지 전용 프로필 > Gemini 채팅 프로필 — 학습 미사용 약관), 없으면 AI Studio 키
        const auth = this._liveAuth();
        const live = new GeminiLive({
            vertex: auth.vertex,
            apiKey: auth.apiKey,
            model: config.liveModel || (auth.vertex ? 'gemini-live-2.5-flash' : 'gemini-2.5-flash-native-audio-preview-09-2025'),
            voiceName: config.liveVoice || 'Charon',
            systemInstruction: sysFull,
            onAudio: (pcm) => {
                if (!rvcBase) return VoiceCall.playPcm24(channelId, pcm);
                segBuf.push(pcm); segBytes += pcm.length;
                if (segBytes >= SEG_BYTES) flushSeg();
            },
            onInterrupted: () => {
                segBuf = []; segBytes = 0; playChain = Promise.resolve();
                VoiceCall.stopPlayback(channelId);
            },
            onTurnComplete: () => {
                if (rvcBase) { flushSeg(); playChain = playChain.then(() => VoiceCall.endTurnAudio(channelId)); }
                else VoiceCall.endTurnAudio(channelId);
                // 통화 내용을 갠톡 기억으로 (자막 누적분 저장)
                if (userBuf.trim()) ChatHistory.addMessage(channelId, 'user', `📞 ${userBuf.trim()}`);
                if (modelBuf.trim()) ChatHistory.addMessage(channelId, 'assistant', `📞 ${modelBuf.trim()}`, character.name);
                userBuf = ''; modelBuf = '';
            },
            onUserText: (t) => { userBuf += t; },
            onModelText: (t) => { modelBuf += t; },
            onClose: () => VoiceCall.end(channelId, 'Live 연결 종료'),
        });
        await live.connect();
        // RVC 서버 미리 깨우기 (콜드스타트 수십초 → 인사 전에 시작)
        if (rvcBase) {
            const headers = config.rvcToken ? { 'x-auth': config.rvcToken } : {};
            fetch(`${rvcBase}/warm`, { headers }).then((r) => console.log(`[RVC] 워밍업: ${r.status}`)).catch((e) => console.warn('[RVC] 워밍업 실패:', e.message));
        }
        return live;
    },

    // PCM(24k mono)을 WAV로 감싸 Modal RVC에 보내고, 변환된 raw PCM(24k mono)을 받는다
    async _rvcConvert(base, pcm24k, voice = '') {
        if (!base) return pcm24k;
        const h = Buffer.alloc(44);
        h.write('RIFF', 0); h.writeUInt32LE(36 + pcm24k.length, 4); h.write('WAVE', 8);
        h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
        h.writeUInt32LE(24000, 24); h.writeUInt32LE(24000 * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
        h.write('data', 36); h.writeUInt32LE(pcm24k.length, 40);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60_000); // 콜드스타트 포함 여유
        try {
            const headers = { 'Content-Type': 'audio/wav' };
            if (config.rvcToken) headers['x-auth'] = config.rvcToken;
            const pitch = Number(config.rvcPitch) || 0;
            const qs = new URLSearchParams();
            if (pitch) qs.set('pitch', String(pitch));
            if (voice) qs.set('voice', voice);
            // 발음 보존 다이얼 (선택): index 낮을수록 한국어 발음 유지, protect 높을수록 자음 보존
            if (config.rvcIndex !== undefined && config.rvcIndex !== '') qs.set('index', String(config.rvcIndex));
            if (config.rvcProtect !== undefined && config.rvcProtect !== '') qs.set('protect', String(config.rvcProtect));
            const q = qs.toString();
            const resp = await fetch(`${base}/convert${q ? `?${q}` : ''}`, {
                method: 'POST', headers, body: Buffer.concat([h, pcm24k]), signal: ctrl.signal,
            });
            if (!resp.ok) throw new Error(`RVC ${resp.status}`);
            return Buffer.from(await resp.arrayBuffer());
        } finally { clearTimeout(timer); }
    },

    // 통화 중 유저 발화 1회분: STT → 히스토리 저장 → 응답 생성
    async _onCallUtterance(channelId, character, userName, wavBuffer) {
        const s = VoiceCall.active(channelId);
        if (!s) return;
        let text = '';
        try { text = await AIClient.transcribeAudio(wavBuffer.toString('base64')); }
        catch (e) { console.warn('[Call] STT 오류:', e.message); return; }
        text = (text || '').trim();
        if (!text || /^\[?\s*no speech\s*\]?\.?$/i.test(text)) return;
        ChatHistory.addMessage(channelId, 'user', `📞 ${text}`);
        if (s.generating) { s.pendingText = true; return; } // 생성 중이면 끝나고 몰아서 답함
        await this._callGenerate(channelId, character, userName, false);
    },

    // 통화 응답 생성 → 텍스트 채널 기록 + TTS 재생. greeting=true면 전화 받는 첫 인사.
    async _callGenerate(channelId, character, userName, greeting = false) {
        const s = VoiceCall.active(channelId);
        if (!s) return;
        s.generating = true;
        try {
            const personaName = this._getPersonaName(channelId);
            const personaText = personaName ? STReader.getPersonaByName(personaName) : '';
            const effUserName = personaName || userName;
            const sys = ContextBuilder.build(character, {
                userName: effUserName,
                language: Langs.get(channelId, config.language || 'ko'),
                mode: 'chat',
                chatSlang: config.chatSlang !== false,
                timezone: config.timezone || 'Asia/Seoul',
                notes: Notes.list(channelId),
                annivStatus: Anniv.status(channelId, config.timezone || 'Asia/Seoul'),
                personaText,
            }) + this._npcLinkedNote(channelId) + this._callNote(effUserName);
            const history = ChatHistory.toAPIMessages(channelId, 24);
            const messages = [{ role: 'system', content: sys }, ...history];
            if (greeting) {
                messages.push({ role: 'user', content: '(The user just called you on the phone and you picked up. Greet them first — short and natural, matching your current mood/situation and time of day.)' });
            }
            // 통화는 지연이 생명: 기본 flash + thinking 끔 (config.callModel로 변경 가능, 'profile'이면 채팅 모델 그대로)
            const callModel = config.callModel === 'profile' ? undefined : (config.callModel || 'gemini-2.5-flash');
            let resp = await AIClient.sendMessage(messages, {
                maxTokens: config.callResponseTokens || 2048,
                geminiModel: callModel,
                noThinking: true,
            });
            resp = this._cleanForSpeech(resp);
            if (!resp) return;
            ChatHistory.addMessage(channelId, 'assistant', `📞 ${resp}`, character.name);
            await VoiceCall.speak(channelId, resp);
        } finally {
            s.generating = false;
            // 생성 중 유저가 더 말했으면 이어서 한 번 더
            if (s.pendingText && VoiceCall.active(channelId)) {
                s.pendingText = false;
                this._callGenerate(channelId, character, userName, false).catch((e) => console.warn('[Call] 후속 생성 오류:', e.message));
            }
        }
    },

    // 통화 모드 지시 (영어 프롬프트, 출력 언어는 ContextBuilder의 langInstruction이 처리)
    _callNote(userName) {
        return `\n\n[VOICE CALL — you are on a LIVE phone call with ${userName} right now]
- This is spoken conversation. Output ONLY the words you actually say out loud.
- NO *actions*, NO emojis, NO markdown, NO [tags], NO narration, NO stage directions. Voice only.
- Talk like a real phone call: short and reactive (usually 1-3 sentences). Do not monologue.
- Natural spoken fillers are good. Laugh in words ("하하"), never typed laughter like "ㅋㅋ".
- If what they said seems cut off or unclear, react like a real person would on the phone (ask them to repeat, etc.).`;
    },

    // TTS로 읽을 수 있게 정리: 태그/마크다운/행동지문/이모지 제거
    _cleanForSpeech(text) {
        if (!text) return '';
        return text
            .replace(/\[[^\]]*\]/g, ' ')            // [태그]
            .replace(/\*[^*]*\*/g, ' ')             // *행동지문*
            .replace(/```[\s\S]*?```/g, ' ')        // 코드블록
            .replace(/[`_~#>|]/g, ' ')              // 마크다운 기호
            .replace(/https?:\/\/\S+/g, ' ')        // URL
            .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ') // 이모지
            .replace(/ㅋ{2,}|ㅎ{2,}/g, ' 하하 ')     // 타이핑 웃음 → 말 웃음
            .replace(/\s+/g, ' ')
            .trim();
    },

    // 통화 상대 음성채널 출입: 들어오면 캐릭터가 받고(자동생성 채널), 나가면 자동 종료
    _onVoiceState(oldState, newState) {
        for (const s of VoiceCall.allSessions()) {
            if (newState.id !== s.userId) continue;
            // 유저가 통화 채널에 들어옴 → 첫 인사 (전화 받기)
            if (!s.greeted && newState.channelId === s.voiceChannel.id) {
                s.greeted = true;
                if (s.joinTimer) { clearTimeout(s.joinTimer); s.joinTimer = null; }
                if (s.greet) s.greet();
                else this._callGenerate(s.channelId, s.character, s.userName, true).catch((e) => console.warn('[Call] 인사 생성 오류:', e.message));
                continue;
            }
            // 통화 중이던 유저가 나감 → 종료
            if (s.greeted && oldState.channelId === s.voiceChannel.id && newState.channelId !== s.voiceChannel.id) {
                VoiceCall.end(s.channelId, '상대가 음성채널을 나갔어요');
            }
        }
    },

    // --- /mode: 세트면 채널 이동(요약 기록 후 점프 링크), 아니면 기존처럼 같은 채널 모드 토글 ---
    async _handleModeSwitch(interaction, channelId, eph) {
        const type = interaction.options.getString('type');
        const found = Sets.findByChannel(channelId);

        // 세트가 아니면: 기존 동작 (같은 채널 모드 플래그)
        if (!found) {
            Modes.set(channelId, type);
            return interaction.reply({ content: `${type === 'rp' ? '🎭 롤플 모드' : '💬 채팅 모드'}로 전환했어요.`, ...eph });
        }

        const { set } = found;
        const target = type === 'rp' ? set.rp : set.chat;
        const fromId = type === 'rp' ? set.chat : set.rp;   // 떠나는 채널

        if (channelId === target) {
            return interaction.reply({ content: `이미 ${type === 'rp' ? '🎭 롤플' : '💬 챗'} 채널이에요. → <#${target}>`, ...eph });
        }

        // 내가 직접 롤플로 전환 = 지금 바로 만남 시작. _startRpScene이 챗 요약→주입까지 함.
        if (type === 'rp') {
            await interaction.reply({ content: '🎭 만남 시작 중 (직전 대화 정리)...', ...eph });
            try { await this._startRpScene(set, '', { notifyChat: false }); } catch (e) { console.warn('[Mode] 장면 시작 실패:', e.message); }
            return interaction.editReply(`🎭 롤플 시작! → <#${set.rp}>\n📝 직전 챗은 <#${set.summary}>에 요약해뒀어요.`);
        }

        // 롤플 → 챗: 떠나는 롤플 대화를 요약해 챗 맥락으로
        await interaction.reply({ content: '🔄 전환 중 (요약 정리)...', ...eph });
        try { await this._summarizeChannel(set, fromId, 'rp→chat', interaction.client); } catch (e) { console.warn('[Mode] 요약 실패:', e.message); }
        return interaction.editReply(`💬 챗으로 이동! → <#${set.chat}>\n📝 직전 롤플은 <#${set.summary}>에 요약해뒀어요.`);
    },

    // --- 채널 최근 대화를 짧게 요약 → 요약채널 게시 + Sets에 저장 ---
    async _summarizeChannel(set, channelId, dir, client) {
        const history = ChatHistory.toAPIMessages(channelId, 30);
        if (!history.length) { console.warn(`[Summary] 히스토리 비어 요약 생략 (채널 ${channelId})`); return; }
        const convo = history.map((m) => `${m.role === 'user' ? 'User' : 'Character'}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n').slice(-4000);
        // 영어(주입용) + 한국어(요약채널 표시용) 둘 다 받는다
        const sys = 'Summarize the following chat log so another channel knows what was discussed / what happened. Output EXACTLY two lines, no preface, no extra text:\nEN: <1-2 sentence summary in English>\nKO: <the same summary in Korean>';
        let raw = '';
        try {
            // thinking 모델은 토큰을 생각에 먼저 쓰므로 본문 여유분을 넉넉히 (300이면 빈 응답 남)
            raw = await AIClient.sendMessage([{ role: 'system', content: sys }, { role: 'user', content: convo }], { maxTokens: 2048 });
        } catch (e) { console.warn('[Summary] 생성 오류:', e.message); }
        raw = (raw || '').trim();
        if (!raw) { console.warn(`[Summary] 빈 요약 — 게시 생략 (채널 ${channelId})`); return; }

        // EN/KO 파싱 (형식 안 지켜졌으면 전체를 영어로 간주, 한국어는 영어로 폴백)
        const en = (raw.match(/EN:\s*(.+)/i)?.[1] || raw).trim();
        const ko = (raw.match(/KO:\s*(.+)/i)?.[1] || en).trim();

        const dateStr = new Intl.DateTimeFormat('ko-KR', { timeZone: config.timezone || 'Asia/Seoul', month: 'long', day: 'numeric' }).format(new Date());
        const arrow = dir === 'chat→rp' ? '💬→🎭' : '🎭→💬';
        Sets.addSummary(set.character, dir, en); // 주입용은 영어

        try {
            const ch = await client.channels.fetch(set.summary).catch(() => null);
            if (ch) await ch.send(`**${dateStr}** ${arrow}\n${ko}`); // 채널 표시는 한국어
        } catch { /* 무시 */ }
    },

    // http(s) 직접 이미지 URL만 아바타로 허용 (imgur 페이지 링크 등 잘못된 값이 들어오면 전송 전체가 실패함)
    _safeAvatarUrl(url) {
        if (!url || typeof url !== 'string') return undefined;
        const u = url.trim();
        if (!/^https?:\/\//i.test(u)) return undefined;
        return u;
    },

    // 단톡 한 인물의 대사를 웹훅(이름+아바타)으로 전송. 실패하면 아바타 빼고 재시도, 그래도 안 되면 일반 메시지로 폴백.
    // avatarUrl(원격) 또는 avatarPath(로컬 파일, 메인 캐릭터 얼굴)로 캐릭터처럼 전송
    async _groupSendVia(channel, name, parts, avatarUrl, avatarPath = null) {
        const hook = await this._getNamedWebhook(channel, `grp-${name}`.slice(0, 80), avatarPath || null);
        const avatarURL = this._safeAvatarUrl(avatarUrl);
        for (const part of parts) {
            if (hook) {
                try {
                    await hook.send({ content: part, username: name, avatarURL });
                    continue;
                } catch (e1) {
                    // 아바타 URL이 원인일 수 있으니 아바타 빼고 한 번 더
                    try {
                        await hook.send({ content: part, username: name });
                        continue;
                    } catch (e2) {
                        delete webhookCache[`${channel.id}:${`grp-${name}`.slice(0, 80)}`];
                        console.warn(`[Group] 웹훅 전송 실패(${name}) → 일반 메시지로 폴백:`, e2.message);
                    }
                }
            }
            // 폴백: 그냥 채널에 이름 붙여 전송 (최소한 단톡은 굴러가게)
            await channel.send(`**${name}**: ${part}`).catch((e) => console.warn(`[Group] 폴백도 실패(${name}):`, e.message));
        }
    },

    async _getNamedWebhook(channel, hookName, avatarPath) {
        const key = `${channel.id}:${hookName}`;
        if (webhookCache[key]) return webhookCache[key];

        try {
            const webhooks = await channel.fetchWebhooks();
            // 이름이 같아도 토큰이 없는 웹훅(다른 앱/UI가 만든 것)은 .send() 불가 → 무시하고 새로 만든다
            let webhook = webhooks.find(wh => wh.name === hookName && wh.token);

            if (!webhook) {
                const opts = { name: hookName };
                if (avatarPath) opts.avatar = avatarPath;
                webhook = await channel.createWebhook(opts);
                console.log(`[Bot] 웹훅 생성: #${channel.name} → ${hookName}`);
            }

            webhookCache[key] = webhook;
            return webhook;
        } catch (e) {
            console.error(`[Bot] 웹훅 생성 실패(#${channel?.name} ${hookName}):`, e.message);
            return null;
        }
    },

    _getWebhook(channel, character) {
        return this._getNamedWebhook(channel, `bridge-${character.name}`, STReader.getCharacterAvatarPath(character));
    },

    // --- 페르소나 프록시: 사용자 메시지를 지우고 페르소나 이름+사진으로 재전송 ---
    // 멀티봇: 페르소나 전담봇(personaClient)이 웹훅/삭제를 맡아 답변봇과 권한 충돌을 피한다.
    async _proxyUserMessage(message, personaName) {
        try {
            const avatarPath = STReader.getPersonaAvatarPath(personaName);
            // 페르소나 전담봇이 있으면 그 봇 시점의 채널 객체로 웹훅 처리
            let channel = message.channel;
            if (personaClient) {
                const c = await personaClient.channels.fetch(message.channelId).catch(() => null);
                if (c) channel = c;
            }
            const webhook = await this._getNamedWebhook(channel, `bridge-persona-${personaName}`, avatarPath);
            if (!webhook) return null;

            const opts = { username: personaName, wait: true };
            const content = message.content || '';
            const files = [...message.attachments.values()].map(a => a.url);
            if (content) opts.content = content;
            if (files.length) opts.files = files;
            if (!opts.content && !opts.files) opts.content = '​'; // 빈 메시지 방지

            const sent = await webhook.send(opts);
            // 이 삭제가 _onMessageDelete의 히스토리 삭제를 트리거하지 않도록 표시
            proxiedMessageIds.add(message.id);
            setTimeout(() => proxiedMessageIds.delete(message.id), 30_000); // 안전 정리
            await message.delete().catch(() => proxiedMessageIds.delete(message.id));
            return sent; // 리액션 대상으로 쓰기 위해 반환
        } catch (e) {
            console.error('[Bot] 페르소나 프록시 실패:', e.message);
            return null;
        }
    },

    // --- 멀티봇: 그 멤버 봇 프로필에 상태(활동 메시지) 표시. 단일봇은 프로필 공유라 생략 ---
    _setStatus(member, text) {
        if (config.botMode !== 'multi' || !member) return;
        let client = null;
        for (const [cl, m] of clientMember) { if (m === member) { client = cl; break; } }
        if (!client?.user) return;
        try {
            client.user.setPresence({
                status: 'online',
                activities: text ? [{ name: text, type: ActivityType.Custom, state: text }] : [],
            });
            console.log(`[Bot] 상태 갱신: ${member.name || member.character} → ${text || '(없음)'}`);
        } catch { /* 무시 */ }
    },

    // --- 채널의 페르소나 이름: config에 수동 지정 있으면 우선, 없으면 ST 자동연결 ---
    _getPersonaName(channelId) {
        const manual = config.channels[channelId]?.persona;
        if (manual) return manual;
        const character = this._getCharacter(channelId);
        // 개별 채널: 연결된 페르소나 자동 탐색. 단톡(시트)엔 단일 캐릭터가 없으니 건너뜀.
        const connected = character ? STReader.getConnectedPersonaName(character) : '';
        if (connected) return connected;
        // 폴백: ST 기본/현재 페르소나 (단톡이 직접 지정 안 했을 때도 내 얼굴로 프록시되게)
        return STReader.getDefaultPersonaName() || '';
    },

    // --- 캐릭터 데이터 캐시 (5분마다 갱신). 카드명으로 로드 ---
    _loadCharacterByName(cardName) {
        if (!cardName) return null;
        const cached = characterCache[cardName];
        if (cached && Date.now() - cached.loadedAt < 5 * 60 * 1000) return cached.data;
        try {
            const data = STReader.getCharacter(cardName);
            characterCache[cardName] = { data, loadedAt: Date.now() };
            return data;
        } catch (e) {
            console.error(`[Bot] 캐릭터 로드 실패 (${cardName}):`, e.message);
            return null;
        }
    },

    // 단일봇: 채널 매핑의 캐릭터
    _getCharacter(channelId) {
        const cardName = config.channels?.[channelId]?.character;
        return this._loadCharacterByName(cardName);
    },

    // 멤버(멀티봇)의 캐릭터 카드 로드. 단체시트면 시트 카드, 아니면 개별 카드.
    _getMemberCharacter(member) {
        if (!member) return null;
        return this._loadCharacterByName(member.sheet || member.character);
    },

    // --- 페르소나 전담봇이 받는 메시지: 웹훅 단톡 채널 처리 ---
    async _onPersonaMessage(message) {
        if (message.author.bot) return;
        if (message.webhookId) return; // 자기가 보낸 웹훅 메시지 무시
        if (config.botMode !== 'multi') return;
        const groupMembers = this._channelGroupMembers(message.channelId);
        if (groupMembers.length < 2) return;        // 단톡 채널 아님
        const gkey = 'grp:' + message.id;
        if (intakeDone.has(gkey)) return;            // 멤버봇이 이미 집었으면 중복 방지
        intakeDone.add(gkey);
        setTimeout(() => intakeDone.delete(gkey), 60_000);
        return this._handleGroupMessage(message, groupMembers).catch((e) => console.error('[Group] 처리 오류:', e));
    },

    // --- 메시지 수신 핸들러 ---
    async _onMessage(message, client) {
        // 봇 메시지 무시
        if (message.author.bot) return;

        const multi = config.botMode === 'multi';
        let member = null;
        let character = null;

        if (multi) {
            member = clientMember.get(client);
            if (!member) return; // 멤버봇 아니면(페르소나봇 등) 무시

            // 단톡 채널(이 채널 담당 멤버가 2명 이상)이면 → 그룹 경로(페르소나봇 1회 호출+분배)로.
            // 메시지당 1번만 처리하기 위해 "먼저 받은 봇"만 진입(intake 잠금).
            const groupMembers = this._channelGroupMembers(message.channelId);
            if (groupMembers.length >= 2) {
                const gkey = 'grp:' + message.id;
                if (intakeDone.has(gkey)) return;     // 다른 멤버봇이 이미 집음
                intakeDone.add(gkey);
                setTimeout(() => intakeDone.delete(gkey), 60_000);
                return this._handleGroupMessage(message, groupMembers).catch((e) => console.error('[Group] 처리 오류:', e));
            }

            character = this._getMemberCharacter(member);
            if (!character) { console.error(`[Bot] 멤버 캐릭터 로드 실패: ${member.name || member.character}`); return; }
            // 1:1: 담당 채널 아니면 무시
            if (!(await this._shouldMemberReply(message, member, client))) return;
        } else {
            const chCfg = config.channels[message.channelId];
            if (!chCfg) return;
            if (chCfg.summaryOnly) return; // 요약 채널: 봇이 대화하지 않음
            // (영화 보자 인식은 AI가 [WATCH:제목] 태그로 → _respond에서 버튼 띄움)
            // 단체 채널(group) / NPC그룹 → 인테이크(저장/프록시) 즉시 + 생성은 타이핑 끝날 때까지 배칭
            if ((chCfg.group && Array.isArray(chCfg.members) && chCfg.members.length >= 1)
                || (chCfg.npcGroup && this._isNpcGroup(message.channelId))) {
                const gkey = 'grp:' + message.id;
                if (intakeDone.has(gkey)) return;
                intakeDone.add(gkey);
                setTimeout(() => intakeDone.delete(gkey), 60_000);
                await this._groupIntake(message, chCfg).catch((e) => console.error('[Group] intake 오류:', e));
                if (Away.isAway(message.channelId)) return;
                this._queueGroupReply(message.channelId, chCfg);
                return;
            }
            character = this._getCharacter(message.channelId);
            if (!character) { console.error(`[Bot] 캐릭터 없음: 채널 ${message.channelId}`); return; }
        }

        // 유저가 답했으니 대기 중인 "재촉" 타이머 취소
        if (followupTimers[message.channelId]) {
            clearTimeout(followupTimers[message.channelId]);
            delete followupTimers[message.channelId];
        }

        const userName = message.author.displayName || message.author.username;

        try {
            // 타이핑 인디케이터
            await message.channel.sendTyping();

            // 사용자 메시지 저장
            let userContent = message.content || '';

            // 이미지 첨부파일 처리
            let imageBase64 = null;
            const imageAttachment = message.attachments.find(a =>
                a.contentType?.startsWith('image/')
            );
            if (imageAttachment) {
                try {
                    const resp = await fetch(imageAttachment.url);
                    const buffer = Buffer.from(await resp.arrayBuffer());
                    const mimeType = imageAttachment.contentType || 'image/png';
                    imageBase64 = `data:${mimeType};base64,${buffer.toString('base64')}`;
                    if (!userContent) userContent = '(사진을 보냈습니다)';
                } catch (e) {
                    console.error('[Bot] 이미지 다운로드 실패:', e.message);
                }
            }

            // 유저 메시지 저장 + 페르소나 프록시는 메시지당 1회만 (그룹챗에서 여러 멤버봇이 봐도)
            let reactTarget = message;
            if (!intakeDone.has(message.id)) {
                intakeDone.add(message.id);
                setTimeout(() => intakeDone.delete(message.id), 60_000);

                // 페르소나 표시 이름: 멀티는 멤버의 persona, 단일은 채널 persona
                const personaName = multi
                    ? (member.persona || (character ? STReader.getConnectedPersonaName(this._getMemberCharacter(member)) : ''))
                    : this._getPersonaName(message.channelId);

                ChatHistory.addMessage(message.channelId, 'user', userContent, personaName || userName);

                if (personaName) {
                    const proxied = await this._proxyUserMessage(message, personaName);
                    if (proxied) reactTarget = proxied;
                }
            }

            if (Away.isAway(message.channelId)) {
                console.log(`[Bot] 잠수 중 - 응답 안 함 (채널 ${message.channelId})`);
                return;
            }

            // 배칭: 모았다가 한 번만 답. 멀티봇은 멤버별로 따로 큐(같은 채널에 여러 캐릭터가 각자 답)
            const queueKey = multi ? `${message.channelId}:${member.token}` : message.channelId;
            this._queueReply(message.channel, queueKey, message.channelId, { imageBase64, userName, reactTarget, member, character });

        } catch (e) {
            console.error(`[Bot] 메시지 처리 오류:`, e);
        }
    },

    // 이 채널을 담당하는 멤버 목록 (config.members 전체 — 토큰 없는 웹훅 멤버 포함)
    _channelGroupMembers(channelId) {
        return (config.members || []).filter((m) => {
            const a = Array.isArray(m.channels) ? m.channels : [];
            return a.includes(channelId);
        });
    },

    // 멤버 → 그 봇 client 찾기
    _clientForMember(member) {
        for (const [cl, m] of clientMember) if (m === member) return cl;
        return null;
    },

    // 단톡 인테이크: 유저 메시지 저장 + 페르소나 프록시 (즉시 — 답 생성은 따로 배칭)
    async _groupIntake(message, chCfg) {
        const channelId = message.channelId;
        const sheetCard = this._loadCharacterByName(chCfg.sheet || chCfg.character);
        const userName = message.author?.displayName || message.author?.username || 'User';
        const personaName = chCfg.persona
            || (sheetCard && STReader.getConnectedPersonaName(sheetCard))
            || STReader.getDefaultPersonaName();
        ChatHistory.addMessage(channelId, 'user', message.content || '(첨부)', personaName || userName);
        if (personaName) {
            await this._proxyUserMessage(message, personaName).catch((e) => console.warn('[Group] 페르소나 프록시 실패:', e.message));
        }
    },

    // 단톡 배칭: 유저가 입력 중이면 답을 미뤘다가, 멈추면 한 번에 생성
    _queueGroupReply(channelId, chCfg) {
        const prev = groupTimers[channelId];
        if (prev?.timer) clearTimeout(prev.timer);
        const firstQueuedAt = prev?.firstQueuedAt || Date.now();
        const t = setTimeout(() => this._flushGroup(channelId), BATCH_WINDOW_MS + this._humanReplyExtra());
        groupTimers[channelId] = { timer: t, firstQueuedAt, chCfg };
    },

    async _flushGroup(channelId) {
        const g = groupTimers[channelId];
        if (!g) return;
        const maxWait = config.replyMaxWaitMs || 25000;
        const stillTyping = (typingUntil[channelId] || 0) > Date.now();
        const waited = Date.now() - (g.firstQueuedAt || Date.now());
        if (stillTyping && waited < maxWait) {
            clearTimeout(g.timer);
            g.timer = setTimeout(() => this._flushGroup(channelId), 1200);
            return;
        }
        if (groupGenerating[channelId]) {
            clearTimeout(g.timer);
            g.timer = setTimeout(() => this._flushGroup(channelId), 1500);
            return;
        }
        const chCfg = g.chCfg;
        delete groupTimers[channelId];
        groupGenerating[channelId] = true;
        try { await this._handleSingleGroup(null, chCfg, { channelId }); }
        catch (e) { console.error('[Group] 처리 오류:', e); }
        finally { groupGenerating[channelId] = false; }
    },

    // --- 단일봇 단체 채널: API 1번 호출 → 인물별 웹훅(이름+아바타URL)으로 분배 ---
    // chCfg = { group:true, sheet, persona, members:[{name, avatarUrl}] }
    // message 없으면(선톡): opts.channelId + opts.seedNote 로 등장인물끼리 먼저 수다 시작
    async _handleSingleGroup(message, chCfg, opts = {}) {
        const channelId = message ? message.channelId : opts.channelId;
        if (!channelId) return;
        let channel = message ? message.channel : null;
        if (!channel) {
            const owner = channelClients[channelId] || primaryClient;
            channel = owner && await owner.channels.fetch(channelId).catch(() => null);
        }
        if (!channel) return;
        const seedNote = opts.seedNote || null;
        const userName = message ? (message.author?.displayName || message.author?.username || 'User') : 'User';

        // 시트 카드 로드: 단톡=시트, NPC그룹=메인 캐릭터 카드
        const sheetCard = this._loadCharacterByName(chCfg.sheet || chCfg.character);
        if (!sheetCard) { console.error('[Group] 카드 로드 실패:', chCfg.sheet || chCfg.character); return; }

        // NPC그룹: 멤버 = [메인 캐릭터, ...NPC들]. 일반 단톡: chCfg.members.
        const isNpc = !!chCfg.npcGroup;
        const mainName = sheetCard.name || chCfg.character;
        const members = isNpc
            ? [{ name: mainName, main: true }, ...((chCfg.npcs || []).map((n) => ({ name: n.name, avatarUrl: n.avatarUrl })))]
            : chCfg.members;

        // 유저 메시지 저장 + 페르소나 프록시 (선톡이면 유저 메시지 없음 → 생략)
        if (message) {
            // 우선순위: 단톡 행 수동 지정 → 카드에 ST 연결된 페르소나 → ST 기본 페르소나
            const personaName = chCfg.persona
                || STReader.getConnectedPersonaName(sheetCard)
                || STReader.getDefaultPersonaName();
            ChatHistory.addMessage(channelId, 'user', message.content || '(첨부)', personaName || userName);
            if (personaName) {
                const proxied = await this._proxyUserMessage(message, personaName).catch((e) => {
                    console.warn('[Group] 페르소나 프록시 실패:', e.message); return null;
                });
                if (!proxied) console.warn(`[Group] 페르소나 프록시 안 됨 (persona="${personaName}") — 웹훅 권한/페르소나 확인`);
            } else {
                console.warn(`[Group] 페르소나 미설정 (채널 ${channelId})`);
            }
        }
        if (Away.isAway(channelId)) return;

        const roster = members.map((m) => m.name).filter(Boolean);
        const mode = Modes.get(channelId);
        const maxTokens = (mode === 'rp' ? (config.rpResponseTokens || 8192) : (config.maxResponseTokens || 1000)) + 1024;

        // 마지막 대화로부터 흐른 시간 (단톡도 리얼타임 반영)
        const lastTs = ChatHistory.lastTimestamp(channelId);
        const gapText = lastTs ? this._humanizeGap((Date.now() - lastTs) / 60000) : '';

        const sys = ContextBuilder.buildGroup(sheetCard, {
            roster,
            language: Langs.get(channelId, config.language || 'ko'),
            timezone: config.timezone || 'Asia/Seoul',
            chatSlang: config.chatSlang !== false,
            seedNote,
            timeGapText: gapText,
            npcMain: isNpc ? mainName : null,
            npcNames: isNpc ? (chCfg.npcs || []).map((n) => n.name) : null,
        }) + this._movieContextNote(channelId)
            + this._npcLinkedNote(channelId)   // 갠톡↔NPC단톡 기억 공유
            + (seedNote ? '' : (isNpc
                // NPC그룹: 유저는 중심이 아니라 "껴 있는" 참가자. 캐릭터들끼리의 대화가 메인.
                ? `\n\n[USER IS IN THE GROUP — not the center]\n- ${userName} just said something in this group. ${userName} is a peripheral member here, NOT the star — the characters have their OWN dynamic among themselves (${mainName} chatting with the NPCs about their own stuff).\n- NPCs may react to ${userName} casually. ${mainName}, who has a PRIVATE 1:1 relationship with ${userName}, reacts specially — can be surprised, tease, or ask why ${userName} is talking here in the group when they usually talk privately ("여기서 왜 그래 ㅋㅋ 우리 따로 얘기하잖아").\n- Do NOT make everything revolve around ${userName}. Keep the group's own conversation going.`
                // 일반 단톡/영화: 유저 말에 먼저 반응
                : `\n\n[USER JUST SPOKE — PRIORITY]\n- ${userName} just said something to you. Lead your reply by reacting/answering ${userName} FIRST. Any movie/scene commentary or among-yourselves banter comes AFTER that. Do NOT push ${userName}'s message behind scene talk.`));
        const history = ChatHistory.toAPIMessages(channelId, config.maxHistoryMessages);
        const messages = [{ role: 'system', content: sys }, ...history];
        if (seedNote) messages.push({ role: 'user', content: `(Situation: ${seedNote} The characters should naturally start chatting among themselves first.)` });

        let response = await AIClient.sendMessage(messages, { maxTokens });
        if (!response) { console.warn('[Group] 빈 응답'); return; }

        // [WATCH: 제목] → 같이보기 버튼 (단톡도)
        let watchTitle = null;
        response = response.replace(/\[WATCH:\s*([^\]]+)\]/i, (_, t) => { watchTitle = t.trim(); return ''; }).trim();
        response = this._stripGroupTags(channelId, response);

        const lines = this._parseGroupLines(response, roster);
        if (lines.length === 0) {
            if (watchTitle) await this._postWatchButton(channel, channelId, watchTitle);
            console.warn('[Group] 파싱 실패:', response.slice(0, 120)); return;
        }
        if (watchTitle) setTimeout(() => this._postWatchButton(channel, channelId, watchTitle).catch(() => {}), 2000);

        ChatHistory.addMessage(channelId, 'assistant', lines.map((l) => `${l.name}: ${l.text}`).join('\n'), isNpc ? mainName : '단톡');

        // 인물별 웹훅으로 순차 전송. 메인 캐릭터는 카드 얼굴(로컬), NPC는 아바타URL.
        const mainAvatarPath = isNpc ? STReader.getCharacterAvatarPath(sheetCard) : null;
        for (const { name, text } of lines) {
            const mem = members.find((m) => m.name === name)
                || members.find((m) => (m.name || '').toLowerCase() === name.toLowerCase());
            if (!mem) continue;
            const parts = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
            await channel.sendTyping().catch(() => {});
            await delay(700 + Math.min(text.length * 18, 2200));
            await this._groupSendVia(channel, name, parts, mem.avatarUrl, mem.main ? mainAvatarPath : null);
        }
    },

    // --- 멀티봇 단톡: 페르소나봇이 API 1번 호출 → 여러 화자 대사 파싱 → 각 캐릭터 봇으로 분배 ---
    async _handleGroupMessage(message, members, seedNote = null) {
        const channelId = message ? message.channelId : (members[0]?.channels || [])[0];
        if (!channelId) return;
        const userName = message?.author?.displayName || message?.author?.username || 'User';

        // 유저 메시지 저장 + 페르소나 프록시 (seed 선톡이면 message 없음)
        let reactTarget = message || null;
        if (message) {
            const personaName = members[0] && this._getMemberPersona(members[0]);
            const userContent = message.content || '(사진/첨부)';
            ChatHistory.addMessage(channelId, 'user', userContent, personaName || userName);
            if (personaName) {
                const proxied = await this._proxyUserMessage(message, personaName).catch(() => null);
                if (proxied) reactTarget = proxied;
            }
        }
        if (Away.isAway(channelId)) return;

        // 화자 후보: 멤버들의 표시 이름
        const roster = members.map((m) => m.name || m.character).filter(Boolean);
        // 대표 캐릭터(시트/프롬프트 빌드용): 첫 멤버 기준 (대개 같은 단체시트)
        const baseChar = this._getMemberCharacter(members[0]);
        if (!baseChar) { console.error('[Group] 캐릭터 로드 실패'); return; }

        const mode = Modes.get(channelId);
        const maxTokens = (mode === 'rp' ? (config.rpResponseTokens || 8192) : (config.maxResponseTokens || 1000)) + 1024;

        // 마지막 대화로부터 흐른 시간 (단톡도 리얼타임 반영)
        const lastTs = ChatHistory.lastTimestamp(channelId);
        const gapText = lastTs ? this._humanizeGap((Date.now() - lastTs) / 60000) : '';

        // 단톡 전용 시스템 프롬프트
        const sys = ContextBuilder.buildGroup(baseChar, {
            roster,
            language: Langs.get(channelId, config.language || 'ko'),
            timezone: config.timezone || 'Asia/Seoul',
            chatSlang: config.chatSlang !== false,
            seedNote,
            timeGapText: gapText,
        });

        const history = ChatHistory.toAPIMessages(channelId, config.maxHistoryMessages);
        const messages = [{ role: 'system', content: sys }, ...history];
        if (seedNote) messages.push({ role: 'user', content: `(Situation: ${seedNote} The characters should naturally start the group chat among themselves.)` });

        let response = await AIClient.sendMessage(messages, { maxTokens });
        if (!response) { console.warn('[Group] 빈 응답'); return; }
        response = this._stripGroupTags(channelId, response);

        // 파싱: "[이름] 대사" 또는 "이름: 대사" 줄들을 화자별로
        const lines = this._parseGroupLines(response, roster);
        if (lines.length === 0) {
            console.warn('[Group] 화자 파싱 실패 — 원문 일부:', response.slice(0, 120));
            return;
        }

        // 히스토리에 합쳐 저장 (다음 턴 맥락용)
        ChatHistory.addMessage(channelId, 'assistant', lines.map((l) => `${l.name}: ${l.text}`).join('\n'), '단톡');

        // 각 줄을 해당 인물로 순차 전송 (텀)
        // - 멤버에 봇 토큰 있으면 그 봇 자신으로 전송(프로필/온라인)
        // - 토큰 없으면 chatsi 웹훅으로 username+avatarUrl 씌워 전송 (봇 12개 안 만들어도 됨)
        for (let i = 0; i < lines.length; i++) {
            const { name, text } = lines[i];
            const mem = members.find((m) => (m.name || m.character) === name)
                || members.find((m) => (m.name || m.character || '').toLowerCase() === name.toLowerCase());
            if (!mem) continue;
            const parts = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
            try {
                if (mem.token) {
                    // 진짜 봇으로
                    const cl = this._clientForMember(mem);
                    const ch = cl && await cl.channels.fetch(channelId).catch(() => null);
                    if (!ch) continue;
                    await ch.sendTyping().catch(() => {});
                    await delay(700 + Math.min(text.length * 18, 2200));
                    for (const part of parts) await ch.send(part);
                } else {
                    // 웹훅으로 (이름+아바타URL). 송출 봇 = 페르소나봇 우선, 없으면 대표봇
                    const sender = personaClient || primaryClient;
                    const ch = sender && await sender.channels.fetch(channelId).catch(() => null);
                    if (!ch) continue;
                    await ch.sendTyping().catch(() => {});
                    await delay(700 + Math.min(text.length * 18, 2200));
                    await this._groupSendVia(ch, name, parts, mem.avatarUrl);
                }
            } catch (e) { console.warn(`[Group] 전송 실패(${name}):`, e.message); }
        }
    },

    // 못 잡은(형식 깨진) 알려진 태그가 본문에 새지 않게 강제 제거하는 안전망
    _stripStrayTags(text) {
        return (text || '').replace(/\[\s*(?:FOLLOW(?:UP)?|REMIND|AWAY|STATUS|REACT|MEET|SEND_PHOTO|WATCH)\b[^\]]*\]/gi, '').trim();
    },

    // 단톡 응답에서 태그 처리(리마인더/팔로업 등록) + 나머지 태그 제거 → [이름] 파싱 전에 호출
    _stripGroupTags(channelId, response) {
        response = response.replace(/\[REMIND:\s*([^|\]]+)\|([^\]]+)\]/gs, (_, timeStr, text) => {
            const fireAt = Reminders.parseToFireAt(timeStr);
            if (fireAt) Reminders.add(channelId, fireAt, text.trim());
            return '';
        }).trim();
        response = response.replace(/\[\s*follow(?:up)?\b[^\]]*\]/gi, (m) => {
            const n = m.match(/\d+/);
            if (n) this._scheduleFollowup(channelId, parseInt(n[0], 10), '');
            return '';
        }).trim();
        return this._stripStrayTags(response);
    },

    // "[이름] 대사" / "이름: 대사" 파싱 → [{name, text}]
    _parseGroupLines(response, roster) {
        const out = [];
        const norm = (s) => s.trim().toLowerCase();
        const known = roster.map(norm);
        const lines = response.split('\n');
        let cur = null;
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            // [이름] 또는 이름: 패턴
            let m = line.match(/^\[([^\]]{1,40})\]\s*(.*)$/) || line.match(/^([^:：]{1,40})[:：]\s*(.*)$/);
            if (m) {
                const nm = m[1].trim();
                if (known.includes(norm(nm))) {
                    // roster의 원래 표기로 복원
                    const realName = roster.find((r) => norm(r) === norm(nm));
                    cur = { name: realName, text: m[2].trim() };
                    out.push(cur);
                    continue;
                }
            }
            // 화자 표시 없는 줄 = 직전 화자에 이어붙임
            if (cur) cur.text += (cur.text ? '\n' : '') + line;
        }
        return out.filter((l) => l.text);
    },

    // 멤버의 페르소나 이름 (수동 우선, 없으면 자동연결)
    _getMemberPersona(member) {
        if (member?.persona) return member.persona;
        const c = this._getMemberCharacter(member);
        return c ? (STReader.getConnectedPersonaName(c) || '') : '';
    },

    // --- 멀티봇: 이 멤버봇이 이번 메시지에 답할지 결정 ---
    async _shouldMemberReply(message, member, client) {
        const chId = message.channelId;
        // 멤버에 담당 채널이 지정돼 있으면, 그 채널이 아니면 무시 (채널별 관리의 핵심)
        const assigned = Array.isArray(member.channels) ? member.channels : [];
        if (assigned.length > 0 && !assigned.includes(chId)) return false;

        // 이 채널을 담당하는 멤버가 몇 명인지 (그룹챗 판정). 담당 지정 안 한 멤버는 전 채널 대상으로 침.
        const here = [];
        for (const m of clientMember.values()) {
            const a = Array.isArray(m.channels) ? m.channels : [];
            if (a.length === 0 || a.includes(chId)) here.push(m);
        }
        // 이 채널 담당이 나 혼자 → 항상 답 (1:1)
        if (here.length <= 1) return true;

        // 그룹챗: 호명되면 답
        const text = (message.content || '').toLowerCase();
        const myName = (member.name || member.character || '').toLowerCase();
        const firstName = myName.split(/[\s'‘’"]/)[0];
        if (myName && text.includes(myName)) return true;
        if (firstName && firstName.length >= 2 && text.includes(firstName)) return true;

        // 호명 안 됐으면 일정 확률만
        return Math.random() < (config.groupChimeInChance ?? 0.25);
    },

    // --- 답장 배칭: 마지막 메시지 후 BATCH_WINDOW_MS 동안 잠잠하면 한 번만 답 ---
    // key=배칭/잠금 단위(멀티는 채널:멤버토큰), channelId=실제 채널(히스토리/페르소나)
    _queueReply(channel, key, channelId, { imageBase64 = null, userName = 'User', reactTarget = null, member = null, character = null } = {}) {
        const prev = pendingReplies[key];
        if (prev) clearTimeout(prev.timer);
        const merged = {
            channel,
            channelId,
            userName,
            member: member || prev?.member || null,
            character: character || prev?.character || null,
            imageBase64: imageBase64 || prev?.imageBase64 || null,
            reactTarget: reactTarget || prev?.reactTarget || null,
            firstQueuedAt: prev?.firstQueuedAt || Date.now(),
            timer: null,
        };
        const wait = BATCH_WINDOW_MS + this._humanReplyExtra();
        merged.timer = setTimeout(() => this._flushReply(key), wait);
        pendingReplies[key] = merged;
    },

    // 사람 같은 답 텀: 대부분 빠르게, 가끔 보통, 드물게 좀 늦게 (config.humanTiming=false로 끔)
    _humanReplyExtra() {
        if (config.humanTiming === false) return 0;
        const rand = (a, b) => a + Math.random() * (b - a);
        const r = Math.random();
        if (r < 0.7) return rand(0, 3000);        // 70%: 거의 바로
        if (r < 0.93) return rand(4000, 12000);   // 23%: 조금 텀
        return rand(15000, 30000);                // 7%: 바빴던 척
    },

    async _flushReply(key) {
        const p = pendingReplies[key];
        if (!p) return;
        // 유저가 아직 입력 중이면 답을 미룬다 (단, 너무 오래 매달리지 않게 상한)
        const maxWait = config.replyMaxWaitMs || 25000;
        const stillTyping = (typingUntil[p.channelId] || 0) > Date.now();
        const waited = Date.now() - (p.firstQueuedAt || Date.now());
        if (stillTyping && waited < maxWait) {
            clearTimeout(p.timer);
            p.timer = setTimeout(() => this._flushReply(key), 1200);
            return;
        }
        if (generating[key]) {
            clearTimeout(p.timer);
            p.timer = setTimeout(() => this._flushReply(key), 1500);
            return;
        }
        delete pendingReplies[key];
        generating[key] = true;
        try {
            await p.channel.sendTyping().catch(() => {});
            const ok = await this._respond(p.channel, p.channelId, {
                imageBase64: p.imageBase64,
                userName: p.userName,
                reactTarget: p.reactTarget,
                member: p.member,
                character: p.character,
            });
            if (!ok) {
                const reply = await p.channel.send('⚠️ 응답을 생성하지 못했어요.').catch(() => null);
                if (reply) setTimeout(() => reply.delete().catch(() => {}), 10_000);
            }
        } catch (e) {
            console.error('[Bot] 답장 처리 오류:', e);
            const errMsg = e.message?.includes('429') || e.message?.includes('RESOURCE_EXHAUSTED')
                ? '⚠️ API 쿼터 초과! 잠시 후 다시 시도해주세요.'
                : `⚠️ 오류 발생: ${e.message?.substring(0, 100)}`;
            const reply = await p.channel.send(errMsg).catch(() => null);
            if (reply) setTimeout(() => reply.delete().catch(() => {}), 10_000);
        } finally {
            generating[key] = false;
        }
    },

    // --- 응답 생성 핵심 (수신/재시도 공용). 성공 시 true ---
    async _respond(channel, channelId, { imageBase64 = null, userName = 'User', reactTarget = null, member = null, character: charArg = null } = {}) {
        const multi = config.botMode === 'multi';
        const character = charArg || (multi && member ? this._getMemberCharacter(member) : this._getCharacter(channelId));
        if (!character) return false;
        // 멤버 표시 이름: 단체시트면 member.name(시트 속 인물), 아니면 카드 name
        const charName = (member && member.name) || character.name || 'Character';
        // 단체 시트면 "이 시트에서 너는 누구"
        const sheetMember = member?.sheet ? (member.name || '') : '';

        // 페르소나
        const personaName = multi
            ? (member?.persona || STReader.getConnectedPersonaName(character) || '')
            : this._getPersonaName(channelId);
        const personaText = personaName ? STReader.getPersonaByName(personaName) : '';
        const effUserName = personaName || userName;

        // 모드 + 모드별 응답 토큰 (RP는 thinking 여유분 포함해 자동 증가)
        const mode = Modes.get(channelId);
        const maxTokens = mode === 'rp'
            ? (config.rpResponseTokens || 8192)
            : (config.maxResponseTokens || 1000);

        const presetName = AIClient.getProfile()?.preset || '';
        const presetText = (mode === 'rp' && presetName) ? STReader.getPresetPromptsByName(presetName) : '';

        // 이전 메시지로부터 흐른 시간 (리얼타임 반영)
        const recent = ChatHistory.getMessages(channelId, 2);
        let timeGapText = '';
        if (recent.length >= 2) {
            const prev = Date.parse(recent[recent.length - 2].timestamp);
            const cur = Date.parse(recent[recent.length - 1].timestamp);
            if (prev && cur && cur > prev) timeGapText = this._humanizeGap((cur - prev) / 60000);
        }

        const systemPrompt = ContextBuilder.build(character, {
            userName: effUserName,
            language: Langs.get(channelId, config.language || 'ko'),
            mode,
            chatSlang: config.chatSlang !== false,
            timezone: config.timezone || 'Asia/Seoul',
            notes: Notes.list(channelId),
            annivStatus: Anniv.status(channelId, config.timezone || 'Asia/Seoul'),
            crossSummaries: this._crossSummariesFor(channelId),
            crossRecent: this._crossRecentFor(channelId),
            meetEnabled: Sets.findByChannel(channelId)?.role === 'chat',
            personaText,
            presetText,
            timeGapText,
            showStatus: multi,
            sheetMember,          // 단체시트 속 "내가 연기할 인물" 이름 (없으면 '')
            charName,             // 멤버 표시 이름
        }) + this._movieContextNote(channelId) + this._npcLinkedNote(channelId);

        const history = ChatHistory.toAPIMessages(channelId, config.maxHistoryMessages);
        const messages = [{ role: 'system', content: systemPrompt }, ...history];

        let response = imageBase64
            ? await AIClient.sendMessageWithImage(messages, imageBase64, { maxTokens })
            : await AIClient.sendMessage(messages, { maxTokens });

        if (!response) {
            console.error('[Bot] AI 응답 없음');
            return false;
        }

        // 태그에서 키워드 뒤 내용만 뽑기 (콜론 유무/대소문자 무관)
        const tagBody = (m, kw) => m.replace(new RegExp(`\\[\\s*${kw}\\b`, 'i'), '').replace(/^[:\s]+/, '').replace(/\]\s*$/, '').trim();

        // [SEND_PHOTO: ...] 태그 — 롤플 모드는 이미지 전송 절대 금지(태그만 제거)
        let photoPrompt = null;
        const photoMatch = response.match(/\[\s*send_photo\b[^\]]*\]/i);
        if (photoMatch) {
            if (mode !== 'rp') photoPrompt = tagBody(photoMatch[0], 'send_photo');
            response = response.replace(photoMatch[0], '').trim();
        }

        // [REACT: 이모지] 태그 → 유저 마지막 메시지에 이모지 리액션 (형식 깨져도 잡음)
        const reactMatch = response.match(/\[\s*react\b[^\]]*\]/i);
        if (reactMatch) {
            const emoji = tagBody(reactMatch[0], 'react');
            response = response.replace(reactMatch[0], '').trim();
            if (reactTarget && emoji) reactTarget.react(emoji).catch((e) => console.warn('[Bot] 리액션 실패:', e.message));
        }

        // [STATUS: 활동] 태그 → 멀티봇 프로필 상태 갱신
        response = response.replace(/\[\s*status\b[^\]]*\]/gi, (m) => {
            this._setStatus(member, tagBody(m, 'status'));
            return '';
        }).trim();

        // [REMIND: 시각 | 메시지] 태그 → 리마인더 등록
        response = response.replace(/\[REMIND:\s*([^|\]]+)\|([^\]]+)\]/gs, (_, timeStr, text) => {
            const fireAt = Reminders.parseToFireAt(timeStr);
            if (fireAt) Reminders.add(channelId, fireAt, text.trim());
            else console.warn(`[Bot] 리마인더 시각 해석 실패/과거: "${timeStr.trim()}"`);
            return '';
        }).trim();

        // [FOLLOWUP] → 그 시간 뒤 유저가 답 없으면 재촉. 형식 깨져도([follow], [followup 5분]) 본문에 안 새게 너그럽게.
        response = response.replace(/\[\s*follow(?:up)?\b[^\]]*\]/gi, (m) => {
            const num = m.match(/\d+/);
            const note = m.match(/\|([^\]]*)\]/);
            if (num) this._scheduleFollowup(channelId, parseInt(num[0], 10), (note ? note[1] : '').trim());
            return '';
        }).trim();

        // [AWAY: 분] → 이 답변 후 그 시간 동안 잠수(무응답), 끝나면 자동 복귀 연락
        response = response.replace(/\[\s*away\b[^\]]*\]/gi, (m) => {
            const n = m.match(/\d+/);
            if (n) Away.setAway(channelId, parseInt(n[0], 10));
            return '';
        }).trim();

        // [MEET: 분 | 상황] → 그 시간 뒤 세트의 롤플 채널에서 만남 RP 장면 자동 시작
        response = response.replace(/\[\s*meet\b[^\]]*\]/gi, (m) => {
            const n = m.match(/\d+/);
            const note = m.match(/\|([^\]]*)\]/);
            if (n) this._scheduleMeet(channelId, parseInt(n[0], 10), (note ? note[1] : '').trim());
            return '';
        }).trim();

        // [WATCH: 제목] → 같이보기 제안 인식 (영어 원제 포함). 본문에서 제거하고 버튼 띄울 준비.
        let watchTitle = null;
        response = response.replace(/\[WATCH:\s*([^\]]+)\]/i, (_, t) => { watchTitle = t.trim(); return ''; }).trim();

        // 안전망: 못 잡은 알려진 태그(형식 깨짐)는 본문에 안 새게 강제 제거
        response = this._stripStrayTags(response);

        // 태그만 있고 본문이 비었으면: 빈 응답 저장/전송하지 않음 (리마인더는 이미 등록됨)
        if (!response && !photoPrompt) {
            console.warn('[Bot] 응답 본문 없음(태그뿐) — 저장/전송 생략');
            if (watchTitle) await this._postWatchButton(channel, channelId, watchTitle);
            return true;
        }

        ChatHistory.addMessage(channelId, 'assistant', response, charName);
        await this._sendResponse(channel, character, response, photoPrompt);
        if (watchTitle) await this._postWatchButton(channel, channelId, watchTitle);
        return true;
    },

    // 긴 텍스트를 limit 이내 조각으로 (문단→줄→문장→하드컷 순으로 자연스럽게 끊음). 넘지 않으면 통째 1개.
    _chunk(text, limit = 1900) {
        const t = (text || '').trim();
        if (t.length <= limit) return t ? [t] : [];
        const out = [];
        let buf = '';
        const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
        // 문단 단위로 모으되 limit 넘으면 끊기
        for (const para of t.split(/\n\s*\n/)) {
            if ((buf + '\n\n' + para).length <= limit) { buf = buf ? `${buf}\n\n${para}` : para; continue; }
            flush();
            if (para.length <= limit) { buf = para; continue; }
            // 문단 자체가 너무 길면 줄/문장/하드컷으로 쪼갬
            let rest = para;
            while (rest.length > limit) {
                let cut = rest.lastIndexOf('\n', limit);
                if (cut < limit * 0.5) cut = rest.lastIndexOf('. ', limit);
                if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
                if (cut < limit * 0.5) cut = limit;
                out.push(rest.slice(0, cut).trim());
                rest = rest.slice(cut).trim();
            }
            buf = rest;
        }
        flush();
        return out;
    },

    // 봇이 방금 생성해 보낸 사진을 비전으로 읽어 히스토리에 기록 → 다음 턴에 자기가 뭘 보냈는지 앎
    async _rememberOwnImage(channelId, imageBuffer, charName) {
        try {
            const dataUrl = `data:image/png;base64,${imageBuffer.toString('base64')}`;
            const desc = await AIClient.sendMessageWithImage(
                [
                    { role: 'system', content: 'Look at this image the character just sent and describe ONLY what is visibly in it in one short factual Korean sentence — what the person is holding, wearing, doing, the setting, expression. No flourish.' },
                    { role: 'user', content: '이 사진에 뭐가 보여?' },
                ],
                dataUrl,
                { maxTokens: 1024 },
            );
            const text = (desc || '').trim();
            if (text) ChatHistory.addMessage(channelId, 'assistant', `(방금 내가 보낸 셀카/사진: ${text})`, charName);
        } catch (e) {
            console.warn('[Bot] 자기 사진 읽기 실패:', e.message);
        }
    },

    // --- 응답 전송: 모드에 따라 분할/통짜 + 이미지 첨부 ---
    // 멀티봇: 봇 자신으로 전송(프로필=캐릭터, 온라인 상태). 단일봇: 웹훅으로 캐릭터 흉내.
    async _sendResponse(channel, character, response, photoPrompt) {
        const charName = character.name || 'Character';
        const asSelf = config.botMode === 'multi';
        const webhook = asSelf ? null : await this._getWebhook(channel, character);

        // RP 모드는 한 덩어리로(안 자름), 채팅 모드는 빈 줄 기준 분할(말풍선 여러 개).
        const isRp = Modes.get(channel.id) === 'rp';
        let parts;
        if (isRp || config.splitMessages === false) {
            // 안 자르되 디스코드 2000자 한계는 지킴 (문단/문장 경계에서 끊음)
            parts = this._chunk(response, 1900);
        } else {
            parts = response.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
        }

        // 이미지 첨부 준비 (마지막 메시지에 붙임)
        let attachment = null;
        if (photoPrompt) {
            try {
                const imageBuffer = await ImageGen.generate(photoPrompt, character);
                if (imageBuffer) {
                    attachment = new AttachmentBuilder(imageBuffer, { name: 'photo.png' });
                    // 자기가 생성한 사진을 실제로 "읽어서" 기억에 남김 (다음 턴에 뭘 보냈는지 앎)
                    this._rememberOwnImage(channel.id, imageBuffer, charName).catch(() => {});
                }
            } catch (e) {
                console.error('[Bot] 이미지 생성 실패:', e.message);
            }
        }

        const sendOne = (content, files) => {
            if (asSelf) {
                const opts = {};
                if (content) opts.content = content;
                if (files) opts.files = files;
                return channel.send(opts);
            }
            if (webhook) {
                const opts = { username: charName };
                if (content) opts.content = content;
                if (files) opts.files = files;
                return webhook.send(opts);
            }
            return channel.send(content ? `**${charName}**: ${content}` : { files });
        };

        // 보낼 텍스트가 없으면: 이미지만 있으면 이미지만 전송, 아무것도 없으면 스킵
        if (parts.length === 0) {
            if (attachment) await sendOne('', [attachment]);
            else console.warn('[Bot] 보낼 내용 없음(빈 응답) — 전송 스킵');
            return;
        }

        for (let i = 0; i < parts.length; i++) {
            const isLast = i === parts.length - 1;
            await sendOne(parts[i], isLast && attachment ? [attachment] : undefined);

            // 다음 메시지 전 타이핑 + 약간의 텀 (실채팅 느낌)
            if (!isLast) {
                try { await channel.sendTyping(); } catch { /* 무시 */ }
                await delay(800 + Math.min(parts[i].length * 20, 2500));
            }
        }
    },

    // 분 단위 시간차 → 사람이 읽는 표현. 30분 미만이면 '' (텀 없음으로 간주)
    _humanizeGap(min) {
        if (min < 30) return '';
        if (min < 60) return `${Math.round(min)}분`;
        const h = min / 60;
        if (h < 24) return `${Math.round(h)}시간`;
        return `${Math.round(h / 24)}일`;
    },

    // --- "답 없으면 재촉": N분 뒤 유저가 답 없으면 다시 연락 ---
    _scheduleFollowup(channelId, minutes, note) {
        if (!Number.isFinite(minutes)) return;
        const mins = Math.min(Math.max(minutes, 1), 120); // 1~120분
        if (followupTimers[channelId]) clearTimeout(followupTimers[channelId]);
        const t = setTimeout(async () => {
            delete followupTimers[channelId];
            // 마지막 메시지가 아직 봇(assistant)이면 = 유저 무응답
            const last = ChatHistory.getMessages(channelId, 1)[0];
            if (last?.role !== 'assistant') return; // 유저가 답함 → 취소
            const noteText = note
                ? `You said "${note}" and they haven't replied for ${mins} minutes. Message them again, lightly pressing/teasing as you said you would.`
                : `It's been ${mins} minutes with no reply. Message them again, lightly nudging them as you implied earlier.`;
            await this.sendProactive(channelId, noteText);
        }, mins * 60_000);
        t.unref?.();
        followupTimers[channelId] = t;
        console.log(`[Bot] 재촉 예약: 채널 ${channelId}, ${mins}분 후`);
    },

    // --- 만남 예약: 챗에서 "곧 만나자" → 그 시간 뒤 세트의 롤플 채널에서 만남 RP 시작 ---
    _scheduleMeet(chatChannelId, minutes, note) {
        if (!Number.isFinite(minutes)) return;
        const found = Sets.findByChannel(chatChannelId);
        if (!found || found.role !== 'chat' || !found.set.rp) {
            console.log('[Meet] 세트 챗 채널이 아니라 만남 예약 스킵');
            return;
        }
        const set = found.set;
        const mins = Math.min(Math.max(minutes, 1), 360); // 1분~6시간
        const key = set.rp;
        if (meetTimers[key]) clearTimeout(meetTimers[key]);
        const t = setTimeout(() => {
            delete meetTimers[key];
            delete meetInfo[key];
            this._startRpScene(set, note).catch((e) => console.error('[Meet] 장면 시작 오류:', e));
        }, mins * 60_000);
        t.unref?.();
        meetTimers[key] = t;
        meetInfo[key] = { fireAt: Date.now() + mins * 60_000, note, character: set.character };
        console.log(`[Meet] "${set.character}" 만남 예약: ${mins}분 후 롤플 채널(${key})`);
    },

    // 텍스트에서 "곧/지금 만남" 신호 → 분 단위 (없으면 null)
    _detectMeetMinutes(text) {
        const t = (text || '');
        // 도착/임박 신호 → 즉시(1분)
        if (/도착|문\s*앞|다\s*왔|왔어|열어\s*줘|들어갈게|들어간다|초인종|벨\s*눌/.test(t)) return 1;
        // "N분 (안에/뒤/후/만에)" → 그 분
        const m = t.match(/(\d{1,3})\s*분\s*(안|뒤|후|만)/);
        if (m) return Math.min(parseInt(m[1], 10), 360);
        // 출발/이동 신호 → 기본 15분
        if (/갈게|갈래|데리러|데리러\s*가|출발|가는\s*중|가고\s*있|이따\s*가|곧\s*가|지금\s*가/.test(t)) return 15;
        return null;
    },

    // 챗에서 만남 신호 자동 감지 → MEET 예약 (캐릭터가 태그를 안 달았을 때 폴백)
    _maybeAutoMeet(chatChannelId, text) {
        const found = Sets.findByChannel(chatChannelId);
        if (!found || found.role !== 'chat' || !found.set.rp) return;
        const mins = this._detectMeetMinutes(text);
        if (mins == null) return;
        const key = found.set.rp;
        const existing = meetInfo[key];
        if (existing) {
            // 이미 예약돼 있으면: "도착 임박" 신호일 때만 1분으로 앞당김
            if (mins <= 1 && existing.fireAt > Date.now() + 2 * 60_000) {
                this._scheduleMeet(chatChannelId, 1, existing.note);
                console.log('[Meet] 자동감지(도착) → 1분으로 앞당김');
            }
            return;
        }
        this._scheduleMeet(chatChannelId, mins, '');
        console.log(`[Meet] 자동감지: "${(text || '').slice(0, 30)}" → ${mins}분`);
    },

    // 만남 시각 도달 → 챗 대화를 요약(맥락 전달)하고 롤플 채널에 만남 장면 시작
    async _startRpScene(set, note, { notifyChat = true } = {}) {
        const client = channelClients[set.rp] || primaryClient;
        if (!client) return;
        // 예약이 남아있으면 정리 (수동/중복 호출 대비)
        if (meetTimers[set.rp]) { clearTimeout(meetTimers[set.rp]); delete meetTimers[set.rp]; }
        delete meetInfo[set.rp];
        // /mode를 안 거치고 자동으로 넘어오는 거라, 여기서 직접 챗을 요약해 rp 맥락으로 넘김
        try { await this._summarizeChannel(set, set.chat, 'chat→rp', client); } catch (e) { console.warn('[Meet] 요약 실패:', e.message); }

        const sceneNote = `${note ? note + ' ' : ''}They have just arrived and you two are now meeting IN PERSON. Open the roleplay scene RIGHT NOW: narrate the moment you meet (the door/arrival, seeing each other, your reaction) using narration and *actions*. This is the start of an in-person scene, not texting.`;
        await this.sendProactive(set.rp, sceneNote, { allowRp: true });

        // 챗 채널에 "도착했어" 알림 + 롤플 채널 점프 링크 (수동 /mode 전환 땐 생략)
        if (notifyChat) {
            try {
                const chatCh = await client.channels.fetch(set.chat).catch(() => null);
                if (chatCh) await chatCh.send(`🚪 (도착했어) 이제부터 여기서 → <#${set.rp}>`);
            } catch { /* 무시 */ }
        }
    },

    // ===== 영화 같이보기 =====
    _sanitizeChannelName(name) {
        const s = (name || '').trim().toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^\p{L}\p{N}\-_]/gu, '')
            .replace(/-+/g, '-')
            .slice(0, 90);
        return s || 'movie';
    },

    // 공통: {캐릭터}MOVIE 카테고리 + {영화} 채널 생성 + 세션/리액션타이머 셋업
    async _openMovieRoom({ charName, movie, group, site = '', srt = false }) {
        charName = (charName || '').trim();
        if (!charName) return { error: '캐릭터 미지정' };
        const card = this._loadCharacterByName(charName);
        if (!card) return { error: `캐릭터 카드 없음: ${charName}` };
        const client = primaryClient;
        if (!client) return { error: '봇 미연결' };

        // 단톡으로 보기: 그 이름으로 단톡 설정(멤버)이 있으면 자동으로 단톡, 없으면 단일.
        // (group=true인데 설정이 없으면 에러)
        let members = null;
        for (const c of Object.values(config.channels)) {
            if (c?.group && Array.isArray(c.members) && c.members.length && (c.sheet === charName || c.character === charName)) { members = c.members; break; }
        }
        if (group && !members) return { error: `"${charName}" 단톡 설정을 ST 확장에서 먼저 만들어주세요 (멤버 목록 필요).` };

        const set = Sets.findByCharacter(charName);
        let guild = set ? await client.guilds.fetch(set.guildId).catch(() => null) : null;
        if (!guild) guild = client.guilds.cache.first();
        if (!guild) return { error: '길드 없음' };
        const me = guild.members.me;
        if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) return { error: '봇에 채널 관리 권한 필요' };

        if (movieSession) { try { await this._movieEnd({}); } catch { /* 무시 */ } }

        const catName = `${charName}MOVIE`;
        const category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === catName)
            || await guild.channels.create({ name: catName, type: ChannelType.GuildCategory });
        const chName = this._sanitizeChannelName(movie);
        const channel = await guild.channels.create({ name: chName, type: ChannelType.GuildText, parent: category.id });

        config.channels[channel.id] = members
            ? { group: true, sheet: charName, members, movie: true }
            : { character: charName, movie: true };
        channelClients[channel.id] = client;
        Modes.set(channel.id, 'chat');
        ChatHistory.clear(channel.id);

        movieSession = {
            character: charName, card, movie, site,
            categoryId: category.id, channelId: channel.id,
            mainChannelId: set?.chat || null,
            group: !!members, members: members || null,
            buffer: [], recentSubs: [], lastReactAt: Date.now(), client, guildId: guild.id,
            // .srt 모드용
            srt, cues: null, cueIdx: 0, startedAt: 0, offsetMs: 0, paused: false, pausedAt: 0, feeder: null,
        };
        movieSession.timer = setInterval(() => this._movieReact().catch((e) => console.warn('[Movie] 리액션 오류:', e.message)), (config.movieReactSec || 35) * 1000);
        return { ok: true, channel, charName, movie, chName };
    },

    // 확장: 같이보기 시작 → 방 생성 (자막은 확장이 실시간 푸시)
    async _movieStart({ character, movie, site, group }) {
        const r = await this._openMovieRoom({ charName: character, movie, group, site });
        if (r.error) return r;
        await r.channel.send(`🎬 **${movie}** 같이 보기 시작! 편하게 봐 — 옆에서 같이 보면서 떠들게.`).catch(() => {});
        console.log(`[Movie] 시작(확장): "${movie}" (${r.charName}) → #${r.chName}`);
        return { ok: true, channelId: r.channel.id };
    },

    // .srt 같이보기 시작 (모바일/iOS): 방 생성 + 자막 타임라인 피더
    async _watchStart({ character, movie, group, srtText }) {
        const cues = Srt.parse(srtText);
        if (!cues.length) return { error: '자막을 못 읽었어요(.srt 형식 확인).' };
        const r = await this._openMovieRoom({ charName: character, movie, group, srt: true });
        if (r.error) return r;
        movieSession.cues = cues;
        // 재생 시작 전 대기 상태(일시정지). /watch go 또는 sync 로 시작.
        movieSession.paused = true;
        movieSession.feeder = setInterval(() => this._watchFeed(), 1000);
        await r.channel.send({
            content: `🎬 **${movie}** 같이 볼 준비 완료! (자막 ${cues.length}줄)\n` +
                `폰에서 **재생 누르는 순간 ▶ 재생** 버튼! 어긋나면 🎯 싱크로 맞춰.`,
            components: [this._watchControls()],
        }).catch(() => {});
        console.log(`[Watch] srt 시작: "${movie}" (${r.charName}), 자막 ${cues.length}줄`);
        return { ok: true, channelId: r.channel.id };
    },

    // 현재 영상 시각(ms) = 경과 - 일시정지누적 + offset
    _watchVideoTime() {
        const s = movieSession;
        if (!s || !s.srt) return 0;
        if (s.paused) return s.offsetMs + (s.pausedAt ? (s.pausedAt - s.startedAt) : 0);
        return s.offsetMs + (Date.now() - s.startedAt);
    },

    // 1초마다: 현재 시각까지 도달한 자막 cue를 버퍼에 밀어넣음 (그럼 _movieReact가 반응)
    _watchFeed() {
        const s = movieSession;
        if (!s || !s.srt || s.paused || !s.cues) return;
        const t = this._watchVideoTime();
        while (s.cueIdx < s.cues.length && s.cues[s.cueIdx].start <= t) {
            const text = s.cues[s.cueIdx].text;
            s.buffer.push(text); s.recentSubs.push(text);
            s.cueIdx++;
        }
        if (s.recentSubs.length > 40) s.recentSubs = s.recentSubs.slice(-40);
        if (s.buffer.length > 400) s.buffer = s.buffer.slice(-400);
        // 끝까지 다 봤으면 자동 마무리
        if (s.cueIdx >= s.cues.length && s.cues.length) {
            console.log('[Watch] 자막 끝 — 자동 종료');
            this._movieEnd().catch(() => {});
        }
    },

    // 재생 시작(t=0부터) — 폰에서 재생 누를 때
    _watchGo() {
        const s = movieSession;
        if (!s || !s.srt) return { error: '진행 중인 .srt 같이보기가 없어요.' };
        s.startedAt = Date.now();
        s.offsetMs = 0;
        s.cueIdx = 0;
        s.paused = false;
        s.pausedAt = 0;
        return { ok: true };
    },

    // 들은 대사로 위치 맞춤
    _watchSync(line) {
        const s = movieSession;
        if (!s || !s.srt || !s.cues) return { error: '진행 중인 .srt 같이보기가 없어요.' };
        const cueMs = Srt.findTimeByText(s.cues, line);
        if (cueMs == null) return { error: '그 대사를 자막에서 못 찾았어요. 좀 더 길게 적어봐.' };
        // 지금 시점이 그 대사 시각이 되도록 offset 재설정
        s.startedAt = Date.now();
        s.offsetMs = cueMs;
        s.paused = false;
        s.pausedAt = 0;
        // cueIdx를 그 위치로
        s.cueIdx = s.cues.findIndex((c) => c.start > cueMs);
        if (s.cueIdx < 0) s.cueIdx = s.cues.length;
        return { ok: true, at: cueMs };
    },

    _watchPause() {
        const s = movieSession;
        if (!s || !s.srt) return { error: '없음' };
        if (!s.paused) { s.paused = true; s.pausedAt = Date.now(); }
        return { ok: true };
    },
    _watchResume() {
        const s = movieSession;
        if (!s || !s.srt) return { error: '없음' };
        if (s.paused) { s.startedAt += (Date.now() - (s.pausedAt || Date.now())); s.paused = false; s.pausedAt = 0; }
        return { ok: true };
    },

    // 확장: 자막 큐 수신 → 버퍼(다음 리액션용) + recentSubs(유저가 말 걸 때 맥락용, 안 비움)
    _movieSub({ cues }) {
        if (!movieSession || !Array.isArray(cues)) return;
        for (const c of cues) {
            const text = (c?.text || '').trim();
            if (text) { movieSession.buffer.push(text); movieSession.recentSubs.push(text); }
        }
        if (movieSession.buffer.length > 400) movieSession.buffer = movieSession.buffer.slice(-400);
        if (movieSession.recentSubs.length > 40) movieSession.recentSubs = movieSession.recentSubs.slice(-40);
    },

    // 영화 중인 채널이면 "지금 보는 중 + 최근 자막" 맥락 블록 (유저가 말 걸 때도 영상 인지하게)
    _movieContextNote(channelId) {
        if (!movieSession || movieSession.channelId !== channelId) return '';
        const subs = (movieSession.recentSubs || []).slice(-15).join('\n');
        return `\n\n[NOW WATCHING — you are all watching "${movieSession.movie}" together right now]\n${subs ? `Recent on-screen subtitles:\n${subs}\n` : ''}- React and talk on the premise that you're watching this video together. If the user says things like "did you see that?", they mean what's on screen. Do NOT act like you're not watching.`;
    },

    // 진짜 NPC 단톡인지: 봇이 /npc create로 파생 생성해 npcgroups.json에 등록된 채널만 해당.
    // (확장에서 NPC그룹 체크+로스터만 입력해둔 1:1 소스 채널은 여기 해당 안 됨 → 1:1로 동작)
    _isNpcGroup(channelId) {
        return !!NpcGroups.get(channelId);
    },

    // predicate에 맞는 채널 id 찾기 (excludeId 제외)
    _findChannel(predicate, excludeId) {
        for (const [id, c] of Object.entries(config.channels || {})) {
            if (id === excludeId) continue;
            try { if (predicate(c, id)) return id; } catch { /* skip */ }
        }
        return null;
    },

    // 갠톡 ↔ NPC단톡 기억 공유: 같은 메인 캐릭터의 반대편 채널 최근 대화를 주입
    _npcLinkedNote(channelId) {
        const chCfg = config.channels[channelId];
        const mainName = chCfg?.character;
        if (!mainName) return '';
        let siblingId = null; let where = '';
        if (this._isNpcGroup(channelId)) {
            // NPC단톡 → 메인의 1:1 갠톡 (파생 단톡이 아닌, 같은 캐릭터의 채널)
            siblingId = this._findChannel((c, id) => c.character === mainName && !this._isNpcGroup(id) && !c.group && !c.movie && !c.summaryOnly, channelId);
            where = 'your private 1:1 chat with the user';
        } else if (!chCfg.group && !chCfg.summaryOnly && !chCfg.movie) {
            // 개별 갠톡 → 메인의 NPC단톡 (실제 파생된 단톡)
            siblingId = this._findChannel((c, id) => this._isNpcGroup(id) && c.character === mainName, channelId);
            where = 'the group chat with your friends (NPCs)';
        }
        if (!siblingId) return '';
        const msgs = ChatHistory.getMessages(siblingId, 12);
        if (!msgs.length) return '';
        const log = msgs.map((m) => `${m.role === 'user' ? 'User' : (m.author || mainName)}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n');
        return `\n\n[SHARED MEMORY — this is ALSO you, from ${where}. One continuous life across both rooms]\n${log}\n- The conversation above is the SAME you, just a different room. Remember what was said there.\n- CRITICAL — stay consistent with your CURRENT situation/state. If you said in the other room that you're in a meeting / busy / somewhere, you are STILL in that same situation here — do NOT contradict it (e.g. don't say you're at lunch when you just said you're in a meeting). Lying/contradicting your own stated state breaks immersion.`;
    },

    // NPC그룹 선톡: NPC가 메인 캐릭터의 지금 모습을 몰래 찍어 단톡에 공유
    async _npcSharePhoto(channelId, chCfg) {
        const mainCard = this._loadCharacterByName(chCfg.character);
        if (!mainCard) return;
        const npcs = (chCfg.npcs || []).filter((n) => n.name);
        if (!npcs.length) return;
        const npc = npcs[Math.floor(Math.random() * npcs.length)];
        const client = channelClients[channelId] || primaryClient;
        const channel = client && await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return;
        const mainName = mainCard.name || chCfg.character;
        const lang = Langs.get(channelId, config.language || 'ko');
        const langLine = lang === 'en' ? 'Write the caption in English.' : 'Write the caption IN KOREAN.';

        // 메인의 현재 상태(갠톡/단톡 히스토리) 반영해 "지금 뭐 하는지" 사진 + NPC 캡션
        const linked = this._npcLinkedNote(channelId);
        const recent = ChatHistory.getMessages(channelId, 8).map((m) => `${m.role === 'user' ? 'User' : (m.author || mainName)}: ${m.content}`).join('\n');
        const sys = `${npc.name} secretly snapped a candid photo of ${mainName} right now and is about to share it in the group chat. Output EXACTLY two lines, no preface:\nPHOTO: <one short ENGLISH description of what ${mainName} is doing in the candid photo — MUST be consistent with ${mainName}'s current situation/state below>\nCAPTION: <${npc.name}'s short playful message sharing the pic to the group. ${langLine}>\n[${mainName} recent context]\n${recent}${linked}`;
        let raw = '';
        try { raw = await AIClient.sendMessage([{ role: 'system', content: sys }, { role: 'user', content: `(${npc.name} shares the candid photo now)` }], { maxTokens: 1024 }); } catch (e) { console.warn('[NPC] 사진 프롬프트 실패:', e.message); return; }
        raw = (raw || '').trim();
        const photoDesc = (raw.match(/PHOTO:\s*(.+)/i)?.[1] || '').trim();
        const caption = (raw.match(/CAPTION:\s*(.+)/i)?.[1] || raw).trim();
        if (!photoDesc) return;

        let buffer = null;
        try { buffer = await ImageGen.generate(`Candid photo of this person: ${photoDesc}`, mainCard); } catch (e) { console.warn('[NPC] 이미지 생성 실패:', e.message); }
        if (!buffer) return; // 이미지 실패하면 조용히 (선톡 안 함)

        const hook = await this._getNamedWebhook(channel, `grp-${npc.name}`.slice(0, 80), null);
        const attachment = new AttachmentBuilder(buffer, { name: 'candid.png' });
        const avatarURL = this._safeAvatarUrl(npc.avatarUrl);
        try {
            if (hook) await hook.send({ content: caption, username: npc.name, avatarURL, files: [attachment] });
            else await channel.send({ content: `**${npc.name}**: ${caption}`, files: [attachment] });
        } catch (e) { console.warn('[NPC] 사진 전송 실패:', e.message); return; }
        ChatHistory.addMessage(channelId, 'assistant', `${npc.name}: ${caption} (${mainName} 사진 공유: ${photoDesc})`, mainName);
        console.log(`[NPC] ${npc.name}가 ${mainName} 사진 공유`);
    },

    // 주기적으로 모인 자막에 캐릭터가 리액션
    async _movieReact() {
        if (!movieSession) return;
        // 유저가 방금 말 걸었으면(답 대기/생성 중) 자막 리액션은 양보 — 유저 답이 먼저
        const ch = movieSession.channelId;
        if (groupTimers[ch] || groupGenerating[ch] || pendingReplies[ch] || generating[ch]) return;
        if (movieSession.group) return this._movieReactGroup();
        const all = movieSession.buffer.splice(0); // 버퍼 비움
        if (all.length === 0) return; // 새 자막 없으면 조용히
        const lines = all.slice(-6); // 밀린 백로그는 버리고 "지금 화면" 최근 것만 → 안 뒤처지게
        movieSession.lastReactAt = Date.now();

        const channel = await movieSession.client.channels.fetch(movieSession.channelId).catch(() => null);
        if (!channel) return;
        const lang = Langs.get(movieSession.channelId, config.language || 'ko');
        const langLine = lang === 'en' ? 'Write in English.' : 'Write IN KOREAN (한국어).';
        const persona = STReader.getConnectedPersonaName(movieSession.card) || STReader.getDefaultPersonaName() || 'User';

        const sys = `You are ${movieSession.card.name || movieSession.character}, sitting right next to ${persona} watching "${movieSession.movie}" together. You are NOT a commentator reacting to subtitles — you're a real person hanging out and watching with them. Below are the subtitle lines that just played.
- Talk WITH ${persona} the way someone actually does while co-watching: sometimes react to what's on screen (laugh, "헐", tease a character, "이 장면 좋아"), but ALSO often just turn to them and chat — ask their opinion ("이거 봤어?", "쟤 왜 저래 ㅋㅋ"), share a feeling, comment on something off-screen ("배 안 고파?", "나 이 배우 좋아"), nudge them.
- Be spontaneous and varied: 1 short line is fine; sometimes a quick 2-3 line burst; sometimes basically silent. Do NOT comment on every single subtitle, and do NOT summarize or quote the subtitles.
- It should feel ALIVE — like they're really beside you on the couch, not a bot narrating the plot.
[Character personality]
${(movieSession.card.description || '').slice(0, 1500)}
- ${langLine}
- No narration/asterisk actions — just chat like texting next to them.`;
        const user = `[Subtitles that just played on screen — for reference only, do NOT quote]\n${lines.join('\n').slice(-1800)}`;
        const history = ChatHistory.toAPIMessages(movieSession.channelId, 20);

        let resp = '';
        try { resp = await AIClient.sendMessage([{ role: 'system', content: sys }, ...history, { role: 'user', content: user }], { maxTokens: config.movieReactTokens || 1536 }); } catch (e) { console.warn('[Movie] 생성 오류:', e.message); }
        resp = (resp || '').trim();
        if (!resp) return;
        ChatHistory.addMessage(movieSession.channelId, 'assistant', resp, movieSession.card.name || movieSession.character);
        await this._sendResponse(channel, movieSession.card, resp, null);
    },

    // 단톡 영화: 등장인물들이 같이 보며 자기들끼리 리액션 (한 번 호출 → 화자별 웹훅 분배)
    async _movieReactGroup() {
        const s = movieSession;
        const all = s.buffer.splice(0);
        if (all.length === 0) return;
        const lines = all.slice(-6); // 밀린 백로그 버리고 최근 것만 → 안 뒤처지게
        s.lastReactAt = Date.now();
        const channel = await s.client.channels.fetch(s.channelId).catch(() => null);
        if (!channel) return;
        const roster = s.members.map((m) => m.name).filter(Boolean);
        const sys = ContextBuilder.buildGroup(s.card, {
            roster,
            language: Langs.get(s.channelId, config.language || 'ko'),
            timezone: config.timezone || 'Asia/Seoul',
            chatSlang: config.chatSlang !== false,
        });
        const user = `(You're all watching "${s.movie}" together. NOT every character on the sheet is here — only the ones who wanted to watch this showed up. Keep it to whoever already reacted; don't suddenly make everyone join. React/banter naturally to the scene that just played. No summarizing or quoting the subtitles, keep it short.)\n[Just-played subtitles]\n${lines.join('\n').slice(-1800)}`;
        let resp = '';
        try { resp = await AIClient.sendMessage([{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: config.movieReactTokens || 1536 }); } catch (e) { console.warn('[Movie] 그룹 생성 오류:', e.message); }
        resp = this._stripGroupTags(s.channelId, (resp || '').trim());
        if (!resp) return;
        const parsed = this._parseGroupLines(resp, roster);
        if (!parsed.length) return;
        ChatHistory.addMessage(s.channelId, 'assistant', parsed.map((l) => `${l.name}: ${l.text}`).join('\n'), '단톡');
        for (const { name, text } of parsed) {
            const mem = s.members.find((m) => m.name === name) || s.members.find((m) => (m.name || '').toLowerCase() === name.toLowerCase());
            if (!mem) continue;
            await channel.sendTyping().catch(() => {});
            await delay(500 + Math.min(text.length * 15, 1800));
            await this._groupSendVia(channel, name, text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean), mem.avatarUrl);
        }
    },

    // 확장/명령: 영화 종료 → 리뷰 남기고 메인으로 복귀
    async _movieEnd() {
        if (!movieSession) return { error: '진행 중인 영화 없음' };
        const s = movieSession;
        movieSession = null; // 재진입 방지
        if (s.timer) clearInterval(s.timer);
        if (s.feeder) clearInterval(s.feeder);

        const channel = await s.client.channels.fetch(s.channelId).catch(() => null);
        const lang = Langs.get(s.channelId, config.language || 'ko');
        const langLine = lang === 'en' ? 'Write in English.' : 'Write IN KOREAN (한국어).';
        const history = ChatHistory.getMessages(s.channelId, 30).map((m) => `${m.role === 'user' ? 'User' : m.author || 'me'}: ${m.content}`).join('\n').slice(-2500);

        let review = '';
        if (s.group && channel) {
            // 단톡: 등장인물 각자 한 줄씩 감상 → 화자별 웹훅
            const roster = s.members.map((m) => m.name).filter(Boolean);
            const sys = ContextBuilder.buildGroup(s.card, { roster, language: lang, timezone: config.timezone || 'Asia/Seoul', chatSlang: config.chatSlang !== false });
            const user = `(You all just finished watching "${s.movie}" together. Each character leaves a short one-line impression + a rating out of 10. Banter is OK.)\n[What we talked about while watching]\n${history}`;
            let resp = '';
            try { resp = await AIClient.sendMessage([{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: 2048 }); } catch { /* 무시 */ }
            const parsed = this._parseGroupLines(this._stripGroupTags(s.channelId, (resp || '').trim()), roster);
            await channel.send(`📝 **${s.movie} — 다 같이 본 후기**`).catch(() => {});
            for (const { name, text } of parsed) {
                const mem = s.members.find((m) => (m.name || '').toLowerCase() === name.toLowerCase());
                if (!mem) continue;
                await this._groupSendVia(channel, name, text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean), mem.avatarUrl);
            }
            review = parsed.map((l) => `${l.name}: ${l.text}`).join(' / ');
            try { await channel.setName(this._sanitizeChannelName(`📝${s.movie}`)); } catch { /* 무시 */ }
        } else {
            // 단일 캐릭터 리뷰
            const sys = `You just finished watching "${s.movie}" together with the user. Give your honest short review/impression of it IN CHARACTER (2-3 sentences): what you felt, best/worst part, rating out of 10. Casual, like talking to someone you watched with. ${langLine}`;
            try { review = await AIClient.sendMessage([{ role: 'system', content: sys }, { role: 'user', content: `[우리가 보면서 나눈 대화 일부]\n${history}` }], { maxTokens: 2048 }); } catch { /* 무시 */ }
            review = (review || '').trim();
            if (channel) {
                if (review) await channel.send(`📝 **${s.movie} — 리뷰**\n${review}`).catch(() => {});
                await channel.send('다 봤다! 너도 한 줄 남겨줘. 여긴 리뷰로 남겨둘게 — 이어서 메인에서 얘기하자 🎬').catch(() => {});
                try { await channel.setName(this._sanitizeChannelName(`📝${s.movie}`)); } catch { /* 무시 */ }
            }
        }
        // 리뷰 채널: 대화는 되지만(말 걸면 답함) 봇이 먼저 선톡하진 않음
        if (config.channels[s.channelId]) { config.channels[s.channelId].movie = false; config.channels[s.channelId].noProactive = true; }

        // 메인 챗으로 복귀: 기억(요약)으로 남기고 먼저 말 걸기
        if (s.mainChannelId) {
            Sets.addSummary?.(s.character, 'movie', `Watched "${s.movie}" together. ${review.slice(0, 200)}`);
            await this.sendProactive(s.mainChannelId, `You two just finished watching "${s.movie}" together. Bring it up in the main chat — ask what they thought, share your own take briefly.`).catch(() => {});
        }
        console.log(`[Movie] 종료: "${s.movie}"`);
        return { ok: true, channelId: s.channelId };
    },

    // "영화 보자" 의도 감지 (미디어 키워드 + 보는 동사)
    _isMovieIntent(text) {
        const t = text || '';
        const media = /(영화|드라마|넷플|디즈니|쿠팡|왓챠|티빙|유튜브|같이\s*[보봐볼])/.test(t);
        const verb = /(보자|볼래|볼까|봐요|봐줘|봅시다|보고\s*싶|볼레|같이\s*보|볼\s*까)/.test(t);
        return media && verb;
    },

    // 메시지에서 영화 제목 추출 (트리거 단어 제거 후 남는 것)
    _extractMovieTitle(text) {
        return (text || '')
            .replace(/["'「」『』]/g, ' ')
            .replace(/[?!.~]+/g, ' ')
            .replace(/(영화|드라마|넷플릭스|넷플|디즈니플러스|디즈니|쿠팡플레이|쿠팡|왓챠|티빙|유튜브)/g, ' ')
            .replace(/(우리|오늘|이번에|지금|좀|한번|같이|함께|이거|그거|저거|나랑|너랑|저기|혹시|시간|괜찮으면요?|괜찮아요?|괜찮|좋으면|어때요?|가능하면|될까요?|해도\s*돼|나중에|이따가?)/g, ' ')
            .replace(/(보고\s*싶어요?|보고\s*싶어|보실래요?|봅시다|보자구|보자|볼래요?|볼까요?|볼레|봐요|봐줘|봐)/g, ' ')
            .replace(/[ㅋㅎㅠㅜ]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    },

    // AI가 [WATCH: 제목] 태그를 달면 같이보기 버튼을 띄운다 (영어 원제 포함)
    async _postWatchButton(channel, channelId, title) {
        if (movieSession) return;                                  // 이미 보는 중
        const chCfg = config.channels[channelId] || {};
        if (chCfg.movie) return;                                   // 이미 영화방
        if (!(chCfg.sheet || chCfg.character)) return;             // 캐릭터 없는 채널
        pendingMovie[channelId] = (title || '').slice(0, 90);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('watch_open').setLabel(`🎬 "${(title || '').slice(0, 60)}" 같이보기`.slice(0, 78)).setStyle(ButtonStyle.Success),
        );
        await channel.send({ content: '👇 누르면 같이보기 시작', components: [row] }).catch(() => {});
    },

    // 제목으로 자막 받아서 시작 (버튼/슬래시 공용). 방 이름은 유저가 친 제목(깔끔), 찾은 자막명은 따로 보여줌.
    async _watchBeginByTitle(character, group, title, lang) {
        if (!title) return { error: '영화 제목이 비었어요.' };
        if (!Subtitles.enabled(config)) return { error: 'OpenSubtitles 키가 없어요. `/watch start` 로 .srt 파일을 첨부해주세요.' };
        const r = await Subtitles.fetchByTitle(config, title, lang === 'en' ? 'en' : 'ko');
        if (r.error) return { error: `자막 검색 실패: ${r.error} (영어 제목으로 다시 / .srt 첨부도 가능)` };
        const res = await this._watchStart({ character, movie: title, group, srtText: r.srtText });
        if (res.ok) res.found = r.name;
        return res;
    },

    // 영화 컨트롤 버튼들 (모바일에서 타이핑 없이)
    _watchControls() {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('watch_go').setLabel('▶ 재생').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('watch_pause').setLabel('⏸ 멈춤').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('watch_resume').setLabel('▶ 재개').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('watch_sync').setLabel('🎯 싱크').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('watch_end').setLabel('⏹ 종료').setStyle(ButtonStyle.Danger),
        );
    },

    async _handleWatchButton(interaction) {
        const eph = { flags: MessageFlags.Ephemeral };
        const id = interaction.customId;
        // "영화 보자" 버튼 → 그 채널의 캐릭터/단톡여부 + 들고있던 제목으로 바로 시작
        if (id === 'watch_open') {
            const ch = interaction.channelId;
            const chCfg = config.channels[ch] || {};
            if (!(chCfg.sheet || chCfg.character)) return interaction.reply({ content: '이 채널에 연결된 캐릭터가 없어요.', ...eph });
            // 제목 입력창(추측값 미리 채움) → 확인/수정하고 시작. 한글 제목이 안 잡히면 영어로.
            const guess = (pendingMovie[ch] || '').slice(0, 90);
            const modal = new ModalBuilder().setCustomId('watch_open_modal').setTitle('뭐 볼까?');
            const input = new TextInputBuilder().setCustomId('title').setLabel('영화 제목 (안 잡히면 영어로! 예: Tangled)').setStyle(TextInputStyle.Short).setRequired(true);
            if (guess) input.setValue(guess);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }
        if (id === 'watch_sync') {
            const modal = new ModalBuilder().setCustomId('watch_sync_modal').setTitle('지금 들린 대사로 맞추기');
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('line').setLabel('방금 들린 대사 한 줄').setStyle(TextInputStyle.Short).setRequired(true),
            ));
            return interaction.showModal(modal);
        }
        if (id === 'watch_end') {
            await interaction.reply({ content: '🎬 종료 처리 중...', ...eph });
            const r = await this._movieEnd().catch((e) => ({ error: e.message }));
            return interaction.editReply(r?.error ? `⚠️ ${r.error}` : '🎬 종료하고 리뷰 남겼어요.');
        }
        let msg = '';
        if (id === 'watch_go') { const r = this._watchGo(); msg = r.error ? `⚠️ ${r.error}` : '▶ 재생 시작! 같이 본다 🍿'; }
        else if (id === 'watch_pause') { this._watchPause(); msg = '⏸ 일시정지'; }
        else if (id === 'watch_resume') { this._watchResume(); msg = '▶ 다시 재생'; }
        else msg = '?';
        return interaction.reply({ content: msg, ...eph });
    },

    async _handleWatchOpenModal(interaction) {
        const eph = { flags: MessageFlags.Ephemeral };
        const ch = interaction.channelId;
        const chCfg = config.channels[ch] || {};
        const character = chCfg.sheet || chCfg.character;
        if (!character) return interaction.reply({ content: '이 채널에 연결된 캐릭터가 없어요.', ...eph });
        const group = !!chCfg.group;
        const title = (interaction.fields.getTextInputValue('title') || '').trim();
        const lang = Langs.get(ch, config.language || 'ko');
        delete pendingMovie[ch];
        await interaction.reply({ content: `🎬 "${title}" 자막 찾는 중...`, ...eph });
        const res = await this._watchBeginByTitle(character, group, title, lang).catch((e) => ({ error: e.message }));
        if (res?.error) return interaction.editReply(`⚠️ ${res.error}`);
        return interaction.editReply(`✅ "${title}" 시작 → <#${res.channelId}> 의 ▶재생 버튼!\n📄 찾은 자막: \`${(res.found || '').slice(0, 70)}\` — 엉뚱하면 ⏹종료하고 영어 제목으로 다시.`);
    },

    async _handleWatchSyncModal(interaction) {
        const eph = { flags: MessageFlags.Ephemeral };
        const line = interaction.fields.getTextInputValue('line');
        const r = this._watchSync(line);
        if (r.error) return interaction.reply({ content: `⚠️ ${r.error}`, ...eph });
        const mm = Math.floor(r.at / 60000), ss = Math.floor((r.at % 60000) / 1000);
        return interaction.reply({ content: `🎯 ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')} 지점으로 맞췄어요.`, ...eph });
    },

    // --- /watch: .srt 자막 동기화 같이보기 (모바일/iOS) ---
    async _handleWatch(interaction, eph) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'start') {
            const character = interaction.options.getString('character');
            const title = interaction.options.getString('title') || '';
            const group = interaction.options.getBoolean('group') || false;
            const att = interaction.options.getAttachment('srt');
            await interaction.reply({ content: '🎬 자막 준비 중...', ...eph });

            // 자막 소스: 첨부파일 우선 → 없으면 제목으로 OpenSubtitles 자동검색
            let srtText = '';
            let movieName = title || (att ? att.name.replace(/\.(srt|vtt)$/i, '') : '');
            if (att) {
                try {
                    const r = await fetch(att.url);
                    srtText = await r.text();
                } catch (e) { return interaction.editReply(`⚠️ 자막 파일 받기 실패: ${e.message}`); }
            } else if (title) {
                if (!Subtitles.enabled(config)) {
                    return interaction.editReply('⚠️ 자막 자동검색이 설정 안 됐어요. `.srt` 파일을 첨부하거나, config에 OpenSubtitles 키를 넣어주세요.');
                }
                const lang = (Langs.get(interaction.channelId, config.language || 'ko'));
                const r = await Subtitles.fetchByTitle(config, title, lang === 'en' ? 'en' : 'ko');
                if (r.error) return interaction.editReply(`⚠️ 자막 자동검색 실패: ${r.error}\n(.srt 파일을 직접 첨부해도 돼요)`);
                srtText = r.srtText; movieName = r.name || title;
            } else {
                return interaction.editReply('⚠️ 영화 제목(title)을 적거나 .srt 파일을 첨부해주세요.');
            }

            const res = await this._watchStart({ character, movie: movieName || '영화', group, srtText }).catch((e) => ({ error: e.message }));
            return interaction.editReply(res?.error ? `⚠️ ${res.error}` : `✅ 준비 완료 → <#${res.channelId}>\n그 방의 **버튼**으로 ▶재생/🎯싱크 누르면 돼 (폰에서 편함)`);
        }

        if (sub === 'go') {
            const r = this._watchGo();
            return interaction.reply({ content: r.error ? `⚠️ ${r.error}` : '▶ 재생 시작! 같이 본다 🍿', ...eph });
        }
        if (sub === 'sync') {
            const r = this._watchSync(interaction.options.getString('line'));
            if (r.error) return interaction.reply({ content: `⚠️ ${r.error}`, ...eph });
            const mm = Math.floor(r.at / 60000), ss = Math.floor((r.at % 60000) / 1000);
            return interaction.reply({ content: `🎯 ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')} 지점으로 맞췄어요.`, ...eph });
        }
        if (sub === 'pause') { this._watchPause(); return interaction.reply({ content: '⏸ 일시정지', ...eph }); }
        if (sub === 'resume') { this._watchResume(); return interaction.reply({ content: '▶ 다시 재생', ...eph }); }
        if (sub === 'end') {
            await interaction.reply({ content: '🎬 종료 처리 중...', ...eph });
            const r = await this._movieEnd().catch((e) => ({ error: e.message }));
            return interaction.editReply(r?.error ? `⚠️ ${r.error}` : '🎬 종료하고 리뷰 남겼어요.');
        }
    },

    // --- 선톡: 봇이 먼저 메시지를 보냄 (스케줄러가 호출) ---
    async sendProactive(channelId, note = '', { allowRp = false } = {}) {
        // 요약 채널 / 영화 끝난 리뷰 채널은 선톡 안 함
        if (config.channels[channelId]?.summaryOnly) return;
        if (config.channels[channelId]?.noProactive) return;
        // 롤플 채널은 선톡 절대 금지 — 만남 전환(_startRpScene)으로 장면 열 때만 예외
        if (!allowRp && Sets.findByChannel(channelId)?.role === 'rp') return;
        // 잠수 중이면 선톡/리마인더/재촉 다 생략 (복귀 연락은 Away가 잠수 해제 후 호출하므로 통과됨)
        if (Away.isAway(channelId)) {
            console.log(`[Bot] 잠수 중 - 선톡 생략 (채널 ${channelId})`);
            return;
        }

        // 멀티봇 단톡 채널이면: 한 명이 씨앗 던지고 등장인물끼리 단톡 시작 (API 1회)
        if (config.botMode === 'multi') {
            const groupMembers = this._channelGroupMembers(channelId);
            if (groupMembers.length >= 2) {
                const seed = note || "The group chat went quiet. Someone revives it with something NEW — continue from the earlier conversation, do NOT repeat any message already sent.";
                return this._handleGroupMessage(null, groupMembers, seed).catch((e) => console.error('[Group] 선톡 오류:', e));
            }
        }

        // 단일봇 단톡(웹훅) 채널이면: 등장인물끼리 먼저 수다 시작 (API 1회)
        const grpCfg = config.channels[channelId];
        if (grpCfg?.group && Array.isArray(grpCfg.members) && grpCfg.members.length >= 1) {
            // 리마인더 등 note가 있으면 그걸 씨앗으로(내용 살림), 없으면 일반 잡담 시작
            const seed = note || "The group chat went quiet. Someone revives it by bringing up something NEW (a fresh thought, what they're doing now, reacting to the time/day) — continue from the earlier conversation, do NOT repeat any message already sent.";
            return this._handleSingleGroup(null, grpCfg, { channelId, seedNote: seed }).catch((e) => console.error('[Group] 선톡 오류:', e));
        }
        // NPC그룹: 가끔 NPC가 메인 캐릭터 사진을 몰래 찍어 공유, 아니면 자기들끼리 수다
        if (grpCfg?.npcGroup && this._isNpcGroup(channelId) && Array.isArray(grpCfg.npcs) && grpCfg.npcs.length >= 1) {
            if (!note && config.proactive?.photos && grpCfg.npcs.some((n) => n.avatarUrl) && Math.random() < 0.35) {
                return this._npcSharePhoto(channelId, grpCfg).catch((e) => console.error('[NPC] 사진공유 오류:', e));
            }
            const seed = note || "The group is chatting among themselves — the main character talking with the NPCs about their own stuff (work/heroics/daily life). The user is peripheral. Bring up something NEW, don't repeat earlier messages.";
            return this._handleSingleGroup(null, grpCfg, { channelId, seedNote: seed }).catch((e) => console.error('[NPC] 선톡 오류:', e));
        }

        const owner = channelClients[channelId] || primaryClient;
        if (!owner) return;
        const channel = await owner.channels.fetch(channelId).catch(() => null);
        if (!channel) return;
        const character = this._getCharacter(channelId);
        if (!character) return;
        const charName = character.name || 'Character';

        try {
            const mode = Modes.get(channelId);
            const maxTokens = mode === 'rp'
                ? (config.rpResponseTokens || 8192)
                : (config.maxResponseTokens || 1000);

            // 선톡 사진(이미지 생성 비용) — config에서 켰을 때만, 35% 확률. 롤플 모드는 이미지 금지.
            const photosOn = !!config.proactive?.photos && mode !== 'rp';
            const wantPhoto = photosOn && Math.random() < 0.35;
            const fullNote = wantPhoto
                ? `${note} This time also attach a photo (a selfie of you right now, or the view you're looking at) by adding [SEND_PHOTO: English description] at the end of your message.`
                : note;

            // 채널별 페르소나 (선톡도 일반 답장과 동일하게 적용 — 전역 페르소나 폴백 방지)
            const personaName = this._getPersonaName(channelId);
            const personaText = personaName ? STReader.getPersonaByName(personaName) : '';
            const effUserName = personaName || 'User';

            const systemPrompt = ContextBuilder.build(character, {
                userName: effUserName,
                language: Langs.get(channelId, config.language || 'ko'),
                mode,
                chatSlang: config.chatSlang !== false,
                timezone: config.timezone || 'Asia/Seoul',
                notes: Notes.list(channelId),
                annivStatus: Anniv.status(channelId, config.timezone || 'Asia/Seoul'),
                crossSummaries: this._crossSummariesFor(channelId),
                crossRecent: this._crossRecentFor(channelId),
                meetEnabled: Sets.findByChannel(channelId)?.role === 'chat',
                personaText,
                proactive: true,
                proactiveNote: fullNote,
                presetText: mode === 'rp' ? STReader.getPresetPromptsByName(AIClient.getProfile()?.preset || '') : '',
                showStatus: config.botMode === 'multi',
            });

            const history = ChatHistory.toAPIMessages(channelId, config.maxHistoryMessages);
            const messages = [
                { role: 'system', content: systemPrompt },
                ...history,
                { role: 'user', content: '(지금 네가 먼저 말을 거는 상황이야. 짧게 메시지를 보내.)' },
            ];

            let response = await AIClient.sendMessage(messages, { maxTokens });
            if (!response) return;

            let photoPrompt = null;
            const photoMatch = response.match(/\[SEND_PHOTO:\s*([^\]]+)\]/s);
            if (photoMatch) {
                if (mode !== 'rp') photoPrompt = photoMatch[1].trim(); // 롤플 모드 이미지 금지
                response = response.replace(photoMatch[0], '').trim();
            }

            // 선톡(단일봇 경로): STATUS/REMIND 태그는 제거만 (선톡은 리마인더 새로 안 만듦)
            response = response.replace(/\[STATUS:\s*([^\]]+)\]/g, '').trim();
            response = response.replace(/\[REMIND:\s*([^|\]]+)\|([^\]]+)\]/gs, '').trim();
            if (!response && !photoPrompt) return; // 보낼 게 없으면 중단

            ChatHistory.addMessage(channelId, 'assistant', response, charName);
            await this._sendResponse(channel, character, response, photoPrompt);
            console.log(`[Bot] 선톡 전송: 채널 ${channelId}`);
        } catch (e) {
            console.error('[Bot] 선톡 실패:', e.message);
        }
    },

    // --- 자동 삭제 에러 메시지 ---
    // 페르소나 프록시가 원본 메시지를 지웠을 수 있으므로 reply가 아니라 채널로 보낸다
    async _tempReply(message, text) {
        try {
            const reply = await message.channel.send(text);
            setTimeout(() => reply.delete().catch(() => {}), 10_000);
        } catch (e) {
            console.error('[Bot] 임시 메시지 전송 실패:', e.message);
        }
    },

    // --- 메시지 삭제 동기화 ---
    async _onMessageDelete(message, client) {
        const multi = config.botMode === 'multi';
        if (!multi && !config.channels[message.channelId]) return;
        // 페르소나 프록시가 지운 원본은 동기화 대상 아님 (재게시된 웹훅이 대체)
        if (proxiedMessageIds.has(message.id)) {
            proxiedMessageIds.delete(message.id);
            return;
        }
        // 같은 삭제를 여러 봇/이벤트가 보므로 1회만 처리
        const k = 'del:' + message.id;
        if (intakeDone.has(k)) return;
        intakeDone.add(k);
        setTimeout(() => intakeDone.delete(k), 60_000);

        // 내용으로 매칭해 그 메시지를 히스토리에서 제거 (유저/페르소나/캐릭터 버블 모두)
        // 캐시 안 된 옛 메시지는 content가 없어 매칭 불가 → 조용히 스킵
        const content = (message.content || '').trim();
        if (!content) return;
        if (ChatHistory.removeByContent(message.channelId, content)) {
            console.log(`[Bot] 메시지 삭제 동기화: 채널 ${message.channelId}`);
        }
    },

    async stop() {
        try { Movie.stop(); } catch { /* 무시 */ }
        if (movieSession?.timer) clearInterval(movieSession.timer);
        if (movieSession?.feeder) clearInterval(movieSession.feeder);
        for (const c of clients) {
            try { c.destroy(); } catch { /* 무시 */ }
        }
        clients.length = 0;
        console.log('[Bot] 종료됨');
    },
};

export default Bot;