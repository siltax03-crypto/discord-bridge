import { Client, GatewayIntentBits, Events, AttachmentBuilder, SlashCommandBuilder, MessageFlags, ActivityType, ChannelType, PermissionFlagsBits } from 'discord.js';
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
// 채널별 답장 배칭: 연달아 온 메시지를 모아 한 번만 답 (중복답 방지 + 사람 같은 타이밍)
const pendingReplies = {};
const BATCH_WINDOW_MS = 3500; // 마지막 메시지 후 이만큼 더 안 오면 답
// 채널별 생성 잠금: 한 채널에서 답 생성은 한 번에 하나만 (생성 중 온 메시지가 별도 답으로 새지 않게)
const generating = {};
// 멀티봇 그룹챗: 한 유저 메시지를 여러 멤버봇이 보므로, 저장/프록시는 한 번만 (메시지ID 기준)
const intakeDone = new Set();

const Bot = {
    async start(cfg) {
        config = cfg;

        // /setup 으로 만든 세트(데이터 파일)를 채널 매핑에 병합 (config.json은 플러그인 소유라 안 건드림)
        this._mergeSets();

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
        if (!interaction.isChatInputCommand()) return;
        const channelId = interaction.channelId;
        const eph = { flags: MessageFlags.Ephemeral };
        const cmd = interaction.commandName;

        // /setup 은 아직 매핑 안 된 채널에서도 실행 가능 (세트를 만드는 명령이므로)
        if (cmd === 'setup') {
            return this._handleSetup(interaction);
        }

        // 단일봇만 채널 매핑 검사 (멀티봇은 봇 초대된 채널 어디서나 동작)
        if (config.botMode !== 'multi' && !config.channels[channelId]) {
            return interaction.reply({ content: '이 채널은 캐릭터와 매핑돼 있지 않아요.', ...eph });
        }

        if (cmd === 'mode') {
            return this._handleModeSwitch(interaction, channelId, eph);
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
            for (const cid of [s.chat, s.rp, s.summary]) if (cid) delete config.channels[cid];
            Sets.remove(s);
            console.log(`[Bot] 채널 삭제 감지 → "${s.character}" 세트 정리`);
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

            const category = await guild.channels.create({ name: charName, type: ChannelType.GuildCategory });
            // 기존 챗 채널을 카테고리 안으로 이동 (같은 채널·ST연결·히스토리 그대로, 보기만 정리)
            try { await interaction.channel.setParent(category.id, { lockPermissions: false }); } catch (e) { console.warn('[Setup] 챗 채널 이동 실패(무시):', e.message); }
            const rp = await guild.channels.create({ name: '롤플', type: ChannelType.GuildText, parent: category.id, permissionOverwrites: priv });
            const summary = await guild.channels.create({ name: '요약', type: ChannelType.GuildText, parent: category.id, permissionOverwrites: priv });

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

            return interaction.editReply(`✅ "${charName}" 세트 완료! (챗은 기존 <#${chatId}> 그대로)\n💬 <#${chatId}>  🎭 <#${rp.id}> (비공개)  📝 <#${summary.id}> (비공개)`);
        } catch (e) {
            console.error('[Setup] 실패:', e);
            return interaction.editReply(`⚠️ 생성 실패: ${e.message}`);
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
        const convo = history.map((m) => `${m.role === 'user' ? '유저' : '캐릭터'}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n').slice(-4000);
        const sys = 'Summarize the following chat log in Korean, in 1-2 short sentences. Capture only what they were talking about / what happened, so the other channel knows the context. No preface, just the summary.';
        let summary = '';
        try {
            // thinking 모델은 토큰을 생각에 먼저 쓰므로 본문 여유분을 넉넉히 (300이면 빈 응답 남)
            summary = await AIClient.sendMessage([{ role: 'system', content: sys }, { role: 'user', content: convo }], { maxTokens: 2048 });
        } catch (e) { console.warn('[Summary] 생성 오류:', e.message); }
        summary = (summary || '').trim();
        if (!summary) { console.warn(`[Summary] 빈 요약 — 게시 생략 (채널 ${channelId})`); return; }

        const dateStr = new Intl.DateTimeFormat('ko-KR', { timeZone: config.timezone || 'Asia/Seoul', month: 'long', day: 'numeric' }).format(new Date());
        const arrow = dir === 'chat→rp' ? '💬→🎭' : '🎭→💬';
        Sets.addSummary(set.character, dir, summary);

        try {
            const ch = await client.channels.fetch(set.summary).catch(() => null);
            if (ch) await ch.send(`**${dateStr}** ${arrow}\n${summary}`);
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
    async _groupSendVia(channel, name, parts, avatarUrl) {
        const hook = await this._getNamedWebhook(channel, `grp-${name}`.slice(0, 80), null);
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
            // 단체 채널(group)이면 → 웹훅 단톡 (API 1번 → 인물별 웹훅 분배)
            if (chCfg.group && Array.isArray(chCfg.members) && chCfg.members.length >= 1) {
                const gkey = 'grp:' + message.id;
                if (intakeDone.has(gkey)) return;
                intakeDone.add(gkey);
                setTimeout(() => intakeDone.delete(gkey), 60_000);
                return this._handleSingleGroup(message, chCfg).catch((e) => console.error('[Group] 처리 오류:', e));
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

    // --- 단일봇 단체 채널: API 1번 호출 → 인물별 웹훅(이름+아바타URL)으로 분배 ---
    // chCfg = { group:true, sheet, persona, members:[{name, avatarUrl}] }
    async _handleSingleGroup(message, chCfg) {
        const channelId = message.channelId;
        const channel = message.channel;
        const userName = message.author?.displayName || message.author?.username || 'User';

        // 시트 카드 로드 (단체 시트 본문)
        const sheetCard = this._loadCharacterByName(chCfg.sheet || chCfg.character);
        if (!sheetCard) { console.error('[Group] 시트 카드 로드 실패:', chCfg.sheet); return; }

        // 유저 메시지 저장 + 페르소나 프록시
        // 우선순위: 단톡 행 수동 지정 → 시트 카드에 ST 연결된 페르소나 → ST 기본 페르소나
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
            console.warn(`[Group] 페르소나 미설정 (채널 ${channelId}) — 단톡 행 페르소나 드롭다운 또는 ST 기본 페르소나 필요`);
        }
        if (Away.isAway(channelId)) return;

        const roster = chCfg.members.map((m) => m.name).filter(Boolean);
        const mode = Modes.get(channelId);
        const maxTokens = (mode === 'rp' ? (config.rpResponseTokens || 8192) : (config.maxResponseTokens || 1000)) + 1024;

        const sys = ContextBuilder.buildGroup(sheetCard, {
            roster,
            language: Langs.get(channelId, config.language || 'ko'),
            timezone: config.timezone || 'Asia/Seoul',
            chatSlang: config.chatSlang !== false,
        });
        const history = ChatHistory.toAPIMessages(channelId, config.maxHistoryMessages);
        const messages = [{ role: 'system', content: sys }, ...history];

        let response = await AIClient.sendMessage(messages, { maxTokens });
        if (!response) { console.warn('[Group] 빈 응답'); return; }

        const lines = this._parseGroupLines(response, roster);
        if (lines.length === 0) { console.warn('[Group] 파싱 실패:', response.slice(0, 120)); return; }

        ChatHistory.addMessage(channelId, 'assistant', lines.map((l) => `${l.name}: ${l.text}`).join('\n'), '단톡');

        // 인물별 웹훅으로 순차 전송 (이름 + 아바타URL)
        for (const { name, text } of lines) {
            const mem = chCfg.members.find((m) => m.name === name)
                || chCfg.members.find((m) => (m.name || '').toLowerCase() === name.toLowerCase());
            if (!mem) continue;
            const parts = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
            await channel.sendTyping().catch(() => {});
            await delay(700 + Math.min(text.length * 18, 2200));
            await this._groupSendVia(channel, name, parts, mem.avatarUrl);
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

        // 단톡 전용 시스템 프롬프트
        const sys = ContextBuilder.buildGroup(baseChar, {
            roster,
            language: Langs.get(channelId, config.language || 'ko'),
            timezone: config.timezone || 'Asia/Seoul',
            chatSlang: config.chatSlang !== false,
            seedNote,
        });

        const history = ChatHistory.toAPIMessages(channelId, config.maxHistoryMessages);
        const messages = [{ role: 'system', content: sys }, ...history];
        if (seedNote) messages.push({ role: 'user', content: `(상황: ${seedNote} — 등장인물들끼리 자연스럽게 단톡을 시작해.)` });

        let response = await AIClient.sendMessage(messages, { maxTokens });
        if (!response) { console.warn('[Group] 빈 응답'); return; }

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
            personaText,
            presetText,
            timeGapText,
            showStatus: multi,
            sheetMember,          // 단체시트 속 "내가 연기할 인물" 이름 (없으면 '')
            charName,             // 멤버 표시 이름
        });

        const history = ChatHistory.toAPIMessages(channelId, config.maxHistoryMessages);
        const messages = [{ role: 'system', content: systemPrompt }, ...history];

        let response = imageBase64
            ? await AIClient.sendMessageWithImage(messages, imageBase64, { maxTokens })
            : await AIClient.sendMessage(messages, { maxTokens });

        if (!response) {
            console.error('[Bot] AI 응답 없음');
            return false;
        }

        // [SEND_PHOTO: ...] 태그
        let photoPrompt = null;
        const photoMatch = response.match(/\[SEND_PHOTO:\s*([^\]]+)\]/s);
        if (photoMatch) {
            photoPrompt = photoMatch[1].trim();
            response = response.replace(photoMatch[0], '').trim();
        }

        // [REACT: 이모지] 태그 → 유저 마지막 메시지에 이모지 리액션
        const reactMatch = response.match(/\[REACT:\s*([^\]]+)\]/);
        if (reactMatch) {
            const emoji = reactMatch[1].trim();
            response = response.replace(reactMatch[0], '').trim();
            if (reactTarget && emoji) reactTarget.react(emoji).catch((e) => console.warn('[Bot] 리액션 실패:', e.message));
        }

        // [STATUS: 활동] 태그 → 멀티봇 프로필 상태 갱신
        response = response.replace(/\[STATUS:\s*([^\]]+)\]/g, (_, text) => {
            this._setStatus(member, text.trim());
            return '';
        }).trim();

        // [REMIND: 시각 | 메시지] 태그 → 리마인더 등록
        response = response.replace(/\[REMIND:\s*([^|\]]+)\|([^\]]+)\]/gs, (_, timeStr, text) => {
            const fireAt = Reminders.parseToFireAt(timeStr);
            if (fireAt) Reminders.add(channelId, fireAt, text.trim());
            else console.warn(`[Bot] 리마인더 시각 해석 실패/과거: "${timeStr.trim()}"`);
            return '';
        }).trim();

        // [FOLLOWUP: 분 | 의도] → 그 시간 뒤 유저가 답 없으면 재촉
        response = response.replace(/\[FOLLOWUP:\s*(\d+)\s*(?:\|([^\]]*))?\]/gi, (_, min, note) => {
            this._scheduleFollowup(channelId, parseInt(min, 10), (note || '').trim());
            return '';
        }).trim();

        // [AWAY: 분] → 이 답변 후 그 시간 동안 잠수(무응답), 끝나면 자동 복귀 연락
        response = response.replace(/\[AWAY:\s*(\d+)\]/gi, (_, min) => {
            Away.setAway(channelId, parseInt(min, 10));
            return '';
        }).trim();

        // [MEET: 분 | 상황] → 그 시간 뒤 세트의 롤플 채널에서 만남 RP 장면 자동 시작
        response = response.replace(/\[MEET:\s*(\d+)\s*(?:\|([^\]]*))?\]/gi, (_, min, note) => {
            this._scheduleMeet(channelId, parseInt(min, 10), (note || '').trim());
            return '';
        }).trim();

        // 태그를 안 달았어도 "곧/지금 만나러 간다"는 말투면 자동으로 만남 예약 (폴백)
        this._maybeAutoMeet(channelId, response);

        // 태그만 있고 본문이 비었으면: 빈 응답 저장/전송하지 않음 (리마인더는 이미 등록됨)
        if (!response && !photoPrompt) {
            console.warn('[Bot] 응답 본문 없음(태그뿐) — 저장/전송 생략');
            return true;
        }

        ChatHistory.addMessage(channelId, 'assistant', response, charName);
        await this._sendResponse(channel, character, response, photoPrompt);
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
                ? `방금 "${note}"라고 했는데 ${mins}분 동안 답이 없어. 그 말대로 살짝 재촉하며 다시 연락해.`
                : `${mins}분째 답이 없어. 아까 한 말대로 살짝 재촉하며 다시 연락해.`;
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
        await this.sendProactive(set.rp, sceneNote);

        // 챗 채널에 "도착했어" 알림 + 롤플 채널 점프 링크 (수동 /mode 전환 땐 생략)
        if (notifyChat) {
            try {
                const chatCh = await client.channels.fetch(set.chat).catch(() => null);
                if (chatCh) await chatCh.send(`🚪 (도착했어) 이제부터 여기서 → <#${set.rp}>`);
            } catch { /* 무시 */ }
        }
    },

    // --- 선톡: 봇이 먼저 메시지를 보냄 (스케줄러가 호출) ---
    async sendProactive(channelId, note = '') {
        // 잠수 중이면 선톡/리마인더/재촉 다 생략 (복귀 연락은 Away가 잠수 해제 후 호출하므로 통과됨)
        if (Away.isAway(channelId)) {
            console.log(`[Bot] 잠수 중 - 선톡 생략 (채널 ${channelId})`);
            return;
        }

        // 멀티봇 단톡 채널이면: 한 명이 씨앗 던지고 등장인물끼리 단톡 시작 (API 1회)
        if (config.botMode === 'multi') {
            const groupMembers = this._channelGroupMembers(channelId);
            if (groupMembers.length >= 2) {
                const seed = note || '지금 단톡방에 아무나 먼저 말을 꺼내서 등장인물들끼리 자연스럽게 수다를 시작해.';
                return this._handleGroupMessage(null, groupMembers, seed).catch((e) => console.error('[Group] 선톡 오류:', e));
            }
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

            // 선톡 사진(이미지 생성 비용) — config에서 켰을 때만, 35% 확률
            const photosOn = !!config.proactive?.photos;
            const wantPhoto = photosOn && Math.random() < 0.35;
            const fullNote = wantPhoto
                ? `${note} 이번엔 지금 너의 모습(셀카)이나 보고 있는 풍경 등을 담은 사진을 메시지 끝에 [SEND_PHOTO: 영어 묘사]로 같이 보내.`
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
                photoPrompt = photoMatch[1].trim();
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
        for (const c of clients) {
            try { c.destroy(); } catch { /* 무시 */ }
        }
        clients.length = 0;
        console.log('[Bot] 종료됨');
    },
};

export default Bot;