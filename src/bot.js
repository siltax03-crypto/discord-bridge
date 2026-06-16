import { Client, GatewayIntentBits, Events, AttachmentBuilder, SlashCommandBuilder } from 'discord.js';
import STReader from './st-reader.js';
import ContextBuilder from './context-builder.js';
import AIClient from './ai-client.js';
import ChatHistory from './chat-history.js';
import ImageGen from './image-gen.js';
import Modes from './modes.js';
import Reminders from './reminders.js';

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
        if (!config.channels[interaction.channelId]) {
            return interaction.reply({ content: '이 채널은 캐릭터와 매핑돼 있지 않아요.', ephemeral: true });
        }

        if (interaction.commandName === 'mode') {
            const type = interaction.options.getString('type');
            Modes.set(interaction.channelId, type);
            const label = type === 'rp' ? '🎭 롤플 모드' : '💬 채팅 모드';
            return interaction.reply({ content: `${label}로 전환했어요.`, ephemeral: true });
        }

        if (interaction.commandName === 'clear') {
            ChatHistory.clear(interaction.channelId);
            return interaction.reply({ content: '🧹 대화 기록을 초기화했어요.', ephemeral: true });
        }
    },

    // --- 채널별 웹훅 가져오기/생성 ---
    async _getWebhook(channel, character) {
        if (webhookCache[channel.id]) return webhookCache[channel.id];

        try {
            // 기존 웹훅 찾기
            const webhooks = await channel.fetchWebhooks();
            let webhook = webhooks.find(wh => wh.name === `bridge-${character.name}`);

            if (!webhook) {
                // 새 웹훅 생성 (캐릭터 아바타 포함)
                const avatarPath = STReader.getCharacterAvatarPath(character);
                const webhookOptions = { name: `bridge-${character.name}` };
                if (avatarPath) {
                    webhookOptions.avatar = avatarPath;
                }
                webhook = await channel.createWebhook(webhookOptions);
                console.log(`[Bot] 웹훅 생성: #${channel.name} → ${character.name}`);
            }

            webhookCache[channel.id] = webhook;
            return webhook;
        } catch (e) {
            console.error(`[Bot] 웹훅 생성 실패:`, e.message);
            return null;
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

        const charName = character.name || 'Character';
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

            // 시스템 프롬프트 빌드
            const systemPrompt = ContextBuilder.build(character, {
                userName,
                language: config.language || 'ko',
                mode: Modes.get(message.channelId),
                chatSlang: config.chatSlang !== false,
                timezone: config.timezone || 'Asia/Seoul',
            });

            // 대화 기록 조립
            const history = ChatHistory.toAPIMessages(message.channelId, config.maxHistoryMessages);
            // 마지막 메시지(방금 저장한 것)는 이미 history에 있음

            const messages = [
                { role: 'system', content: systemPrompt },
                ...history,
            ];

            // AI 호출
            let response;
            if (imageBase64) {
                response = await AIClient.sendMessageWithImage(messages, imageBase64);
            } else {
                response = await AIClient.sendMessage(messages);
            }

            if (!response) {
                console.error('[Bot] AI 응답 없음');
                this._tempReply(message, '⚠️ 응답을 생성하지 못했어요.');
                return;
            }

            // [SEND_PHOTO: ...] 태그 감지 및 처리
            let photoPrompt = null;
            const photoMatch = response.match(/\[SEND_PHOTO:\s*([^\]]+)\]/s);
            if (photoMatch) {
                photoPrompt = photoMatch[1].trim();
                response = response.replace(photoMatch[0], '').trim();
            }

            // [REMIND: 시각 | 메시지] 태그 감지 → 리마인더 등록 (여러 개 가능)
            response = response.replace(/\[REMIND:\s*([^|\]]+)\|([^\]]+)\]/gs, (_, timeStr, text) => {
                const fireAt = Reminders.parseToFireAt(timeStr);
                if (fireAt) {
                    Reminders.add(message.channelId, fireAt, text.trim());
                } else {
                    console.warn(`[Bot] 리마인더 시각 해석 실패/과거: "${timeStr.trim()}"`);
                }
                return ''; // 태그는 메시지에서 제거
            }).trim();

            // 응답 저장
            ChatHistory.addMessage(message.channelId, 'assistant', response, charName);

            // 전송 (빈 줄 기준으로 여러 메시지로 분할)
            await this._sendResponse(message.channel, character, response, photoPrompt);

        } catch (e) {
            console.error(`[Bot] 메시지 처리 오류:`, e);
            const errMsg = e.message?.includes('429') || e.message?.includes('RESOURCE_EXHAUSTED')
                ? '⚠️ API 쿼터 초과! 잠시 후 다시 시도해주세요.'
                : `⚠️ 오류 발생: ${e.message?.substring(0, 100)}`;
            this._tempReply(message, errMsg);
        }
    },

    // --- 응답 전송: 빈 줄 기준으로 여러 메시지로 분할 + 이미지 첨부 ---
    async _sendResponse(channel, character, response, photoPrompt) {
        const charName = character.name || 'Character';
        const webhook = await this._getWebhook(channel, character);

        // 빈 줄(\n\n) 기준 분할. splitMessages가 false면 통째로.
        let parts =
            config.splitMessages === false
                ? [response]
                : response.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
        if (parts.length === 0) parts = [response];

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
            const systemPrompt = ContextBuilder.build(character, {
                userName: 'User',
                language: config.language || 'ko',
                mode: Modes.get(channelId),
                chatSlang: config.chatSlang !== false,
                timezone: config.timezone || 'Asia/Seoul',
                proactive: true,
                proactiveNote: note,
            });

            const history = ChatHistory.toAPIMessages(channelId, config.maxHistoryMessages);
            const messages = [
                { role: 'system', content: systemPrompt },
                ...history,
                { role: 'user', content: '(지금 네가 먼저 말을 거는 상황이야. 짧게 메시지를 보내.)' },
            ];

            let response = await AIClient.sendMessage(messages);
            if (!response) return;

            let photoPrompt = null;
            const photoMatch = response.match(/\[SEND_PHOTO:\s*([^\]]+)\]/s);
            if (photoMatch) {
                photoPrompt = photoMatch[1].trim();
                response = response.replace(photoMatch[0], '').trim();
            }

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