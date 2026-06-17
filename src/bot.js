import { Client, GatewayIntentBits, Events, AttachmentBuilder, SlashCommandBuilder, MessageFlags } from 'discord.js';
import STReader from './st-reader.js';
import ContextBuilder from './context-builder.js';
import AIClient from './ai-client.js';
import ChatHistory from './chat-history.js';
import ImageGen from './image-gen.js';
import Modes from './modes.js';
import Reminders from './reminders.js';
import Notes from './notes.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let client = null;
let config = {};
// 채널별 웹훅 캐시: { channelId: webhookObject }
const webhookCache = {};
// 채널별 캐릭터 데이터 캐시
const characterCache = {};

const Bot = {
    async start(cfg) {
        config = cfg;

        client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
            ],
        });

        client.once(Events.ClientReady, async (c) => {
            console.log(`[Bot] 로그인 완료: ${c.user.tag}`);
            console.log(`[Bot] 매핑된 채널: ${Object.keys(config.channels).length}개`);
            await this._registerCommands();
        });

        client.on(Events.MessageCreate, (message) => this._onMessage(message));
        client.on(Events.MessageDelete, (message) => this._onMessageDelete(message));
        client.on(Events.InteractionCreate, (interaction) => this._onInteraction(interaction));

        await client.login(config.discordToken);
    },

    // --- 슬래시 명령어 등록 (서버별로 즉시 반영) ---
    async _registerCommands() {
        const commands = [
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
                .setName('clear')
                .setDescription('이 채널의 대화 기록 초기화'),
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
                .setName('info')
                .setDescription('이 채널에 주입되는 정보 보기 (캐릭터/페르소나/메모리 등)'),
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
    async _onInteraction(interaction) {
        if (!interaction.isChatInputCommand()) return;
        const channelId = interaction.channelId;
        const eph = { flags: MessageFlags.Ephemeral };

        if (!config.channels[channelId]) {
            return interaction.reply({ content: '이 채널은 캐릭터와 매핑돼 있지 않아요.', ...eph });
        }

        const cmd = interaction.commandName;

        if (cmd === 'mode') {
            const type = interaction.options.getString('type');
            Modes.set(channelId, type);
            const label = type === 'rp' ? '🎭 롤플 모드' : '💬 채팅 모드';
            return interaction.reply({ content: `${label}로 전환했어요.`, ...eph });
        }

        if (cmd === 'clear') {
            ChatHistory.clear(channelId);
            return interaction.reply({ content: '🧹 대화 기록을 초기화했어요.', ...eph });
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

        if (cmd === 'info') {
            const character = this._getCharacter(channelId);
            if (!character) return interaction.reply({ content: '⚠️ 캐릭터 로드 실패', ...eph });
            const charName = character.name || '?';
            const descLen = (character.description || '').length;

            const personaName = config.channels[channelId]?.persona;
            const personaText = personaName ? STReader.getPersonaByName(personaName) : STReader.getPersonaDescription();

            const mode = Modes.get(channelId);
            const charBook = STReader.getCharacterBook(character).length;
            const worldName = STReader.getCharacterWorldName(character);
            const worldEntries = STReader.getWorldInfo(worldName).length;

            const charId = character.avatar?.replace(/\.[^/.]+$/, '') || charName;
            const charm = STReader.getCharmMemory(charId);
            const charmCount = charm?.memories?.length || 0;

            const lines = [
                '**📋 채널 주입 정보**',
                `• 캐릭터: ${charName} (설명 ${descLen}자)`,
                `• 페르소나: ${personaName || '(기본)'} ${personaText ? `(${personaText.length}자)` : '(없음)'}`,
                `• 모드: ${mode === 'rp' ? '🎭 롤플' : '💬 채팅'}`,
                `• 로어북: 캐릭터북 ${charBook}개 + 월드"${worldName || '-'}" ${worldEntries}개`,
                `• CHARM 메모리: ${charmCount}개`,
                `• 작가노트: ${Notes.list(channelId).length}개`,
                `• 리마인더: ${Reminders.listForChannel(channelId).length}개`,
                `• 프리셋: ${STReader.getPresetName(config.connectionProfile) || '없음'} ${mode === 'rp' ? '(RP 주입중)' : '(채팅 모드라 미주입)'}`,
            ];
            return interaction.reply({ content: lines.join('\n'), ...eph });
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
    async _getNamedWebhook(channel, hookName, avatarPath) {
        const key = `${channel.id}:${hookName}`;
        if (webhookCache[key]) return webhookCache[key];

        try {
            const webhooks = await channel.fetchWebhooks();
            let webhook = webhooks.find(wh => wh.name === hookName);

            if (!webhook) {
                const opts = { name: hookName };
                if (avatarPath) opts.avatar = avatarPath;
                webhook = await channel.createWebhook(opts);
                console.log(`[Bot] 웹훅 생성: #${channel.name} → ${hookName}`);
            }

            webhookCache[key] = webhook;
            return webhook;
        } catch (e) {
            console.error(`[Bot] 웹훅 생성 실패:`, e.message);
            return null;
        }
    },

    _getWebhook(channel, character) {
        return this._getNamedWebhook(channel, `bridge-${character.name}`, STReader.getCharacterAvatarPath(character));
    },

    // --- 페르소나 프록시: 사용자 메시지를 지우고 페르소나 이름+사진으로 재전송 ---
    async _proxyUserMessage(message, personaName) {
        try {
            const avatarPath = STReader.getPersonaAvatarPath(personaName);
            const webhook = await this._getNamedWebhook(message.channel, `bridge-persona-${personaName}`, avatarPath);
            if (!webhook) return;

            const opts = { username: personaName };
            const content = message.content || '';
            const files = [...message.attachments.values()].map(a => a.url);
            if (content) opts.content = content;
            if (files.length) opts.files = files;
            if (!opts.content && !opts.files) opts.content = '​'; // 빈 메시지 방지

            await webhook.send(opts);
            await message.delete().catch(() => {});
        } catch (e) {
            console.error('[Bot] 페르소나 프록시 실패:', e.message);
        }
    },

    // --- 캐릭터 데이터 캐시 (5분마다 갱신) ---
    _getCharacter(channelId) {
        const channelConfig = config.channels[channelId];
        if (!channelConfig) return null;

        const cached = characterCache[channelId];
        if (cached && Date.now() - cached.loadedAt < 5 * 60 * 1000) {
            return cached.data;
        }

        try {
            const data = STReader.getCharacter(channelConfig.character);
            characterCache[channelId] = { data, loadedAt: Date.now() };
            return data;
        } catch (e) {
            console.error(`[Bot] 캐릭터 로드 실패 (${channelConfig.character}):`, e.message);
            return null;
        }
    },

    // --- 메시지 수신 핸들러 ---
    async _onMessage(message) {
        // 봇 메시지 무시
        if (message.author.bot) return;
        // 매핑된 채널이 아니면 무시
        if (!config.channels[message.channelId]) return;

        const character = this._getCharacter(message.channelId);
        if (!character) {
            console.error(`[Bot] 캐릭터 없음: 채널 ${message.channelId}`);
            return;
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

            ChatHistory.addMessage(message.channelId, 'user', userContent, userName);

            // 페르소나가 지정된 채널이면 내 메시지를 페르소나 이름+사진으로 갈아끼움
            const personaName = config.channels[message.channelId]?.persona;
            if (personaName) await this._proxyUserMessage(message, personaName);

            const ok = await this._respond(message.channel, message.channelId, { imageBase64, userName });
            if (!ok) this._tempReply(message, '⚠️ 응답을 생성하지 못했어요.');

        } catch (e) {
            console.error(`[Bot] 메시지 처리 오류:`, e);
            const errMsg = e.message?.includes('429') || e.message?.includes('RESOURCE_EXHAUSTED')
                ? '⚠️ API 쿼터 초과! 잠시 후 다시 시도해주세요.'
                : `⚠️ 오류 발생: ${e.message?.substring(0, 100)}`;
            this._tempReply(message, errMsg);
        }
    },

    // --- 응답 생성 핵심 (수신/재시도 공용). 성공 시 true ---
    async _respond(channel, channelId, { imageBase64 = null, userName = 'User' } = {}) {
        const character = this._getCharacter(channelId);
        if (!character) return false;
        const charName = character.name || 'Character';

        // 채널별 페르소나 (지정 시 그 페르소나로 인식)
        const personaName = config.channels[channelId]?.persona;
        const personaText = personaName ? STReader.getPersonaByName(personaName) : '';
        const effUserName = personaName || userName;

        // 모드 + 모드별 응답 토큰 (RP는 thinking 여유분 포함해 자동 증가)
        const mode = Modes.get(channelId);
        const maxTokens = mode === 'rp'
            ? (config.rpResponseTokens || 8192)
            : (config.maxResponseTokens || 1000);

        const presetText = mode === 'rp' ? STReader.getPresetPrompts(config.connectionProfile) : '';

        const systemPrompt = ContextBuilder.build(character, {
            userName: effUserName,
            language: config.language || 'ko',
            mode,
            chatSlang: config.chatSlang !== false,
            timezone: config.timezone || 'Asia/Seoul',
            notes: Notes.list(channelId),
            personaText,
            presetText,
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

        // [REMIND: 시각 | 메시지] 태그 → 리마인더 등록
        response = response.replace(/\[REMIND:\s*([^|\]]+)\|([^\]]+)\]/gs, (_, timeStr, text) => {
            const fireAt = Reminders.parseToFireAt(timeStr);
            if (fireAt) Reminders.add(channelId, fireAt, text.trim());
            else console.warn(`[Bot] 리마인더 시각 해석 실패/과거: "${timeStr.trim()}"`);
            return '';
        }).trim();

        // 태그만 있고 본문이 비었으면: 빈 응답 저장/전송하지 않음 (리마인더는 이미 등록됨)
        if (!response && !photoPrompt) {
            console.warn('[Bot] 응답 본문 없음(태그뿐) — 저장/전송 생략');
            return true;
        }

        ChatHistory.addMessage(channelId, 'assistant', response, charName);
        await this._sendResponse(channel, character, response, photoPrompt);
        return true;
    },

    // --- 응답 전송: 빈 줄 기준으로 여러 메시지로 분할 + 이미지 첨부 ---
    async _sendResponse(channel, character, response, photoPrompt) {
        const charName = character.name || 'Character';
        const webhook = await this._getWebhook(channel, character);

        // 빈 줄(\n\n) 기준 분할. splitMessages가 false면 통째로. 빈 조각은 제거.
        const parts = (config.splitMessages === false ? [response] : response.split(/\n\s*\n/))
            .map((s) => s.trim())
            .filter(Boolean);

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

        // 보낼 텍스트가 없으면: 이미지만 있으면 이미지만 전송, 아무것도 없으면 스킵
        if (parts.length === 0) {
            if (attachment) {
                if (webhook) await webhook.send({ username: charName, files: [attachment] });
                else await channel.send({ files: [attachment] });
            } else {
                console.warn('[Bot] 보낼 내용 없음(빈 응답) — 전송 스킵');
            }
            return;
        }

        for (let i = 0; i < parts.length; i++) {
            const isLast = i === parts.length - 1;
            const opts = { content: parts[i], username: charName };
            if (isLast && attachment) opts.files = [attachment];

            if (webhook) {
                await webhook.send(opts);
            } else {
                await channel.send(`**${charName}**: ${parts[i]}`);
            }

            // 다음 메시지 전 타이핑 + 약간의 텀 (실채팅 느낌)
            if (!isLast) {
                try {
                    await channel.sendTyping();
                } catch {
                    /* 무시 */
                }
                await delay(800 + Math.min(parts[i].length * 20, 2500));
            }
        }
    },

    // --- 선톡: 봇이 먼저 메시지를 보냄 (스케줄러가 호출) ---
    async sendProactive(channelId, note = '') {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return;
        const character = this._getCharacter(channelId);
        if (!character) return;
        const charName = character.name || 'Character';

        try {
            const mode = Modes.get(channelId);
            const maxTokens = mode === 'rp'
                ? (config.rpResponseTokens || 8192)
                : (config.maxResponseTokens || 1000);

            const systemPrompt = ContextBuilder.build(character, {
                userName: 'User',
                language: config.language || 'ko',
                mode,
                chatSlang: config.chatSlang !== false,
                timezone: config.timezone || 'Asia/Seoul',
                proactive: true,
                proactiveNote: note,
                presetText: mode === 'rp' ? STReader.getPresetPrompts(config.connectionProfile) : '',
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

            // 선톡은 리마인더를 새로 만들지 않는다 (태그만 제거)
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
    async _tempReply(message, text) {
        try {
            const reply = await message.reply(text);
            setTimeout(() => reply.delete().catch(() => {}), 10_000);
        } catch (e) {
            console.error('[Bot] 임시 메시지 전송 실패:', e.message);
        }
    },

    // --- 메시지 삭제 동기화 ---
    async _onMessageDelete(message) {
        if (message.author?.bot) return;
        if (!config.channels[message.channelId]) return;

        const removed = ChatHistory.removeLastUserMessage(message.channelId);
        if (removed) {
            console.log(`[Bot] 메시지 삭제 동기화: 채널 ${message.channelId}`);
        }
    },

    async stop() {
        if (client) {
            client.destroy();
            console.log('[Bot] 종료됨');
        }
    },
};

export default Bot;