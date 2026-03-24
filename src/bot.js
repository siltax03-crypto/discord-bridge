import { Client, GatewayIntentBits, Events, AttachmentBuilder } from 'discord.js';
import STReader from './st-reader.js';
import ContextBuilder from './context-builder.js';
import AIClient from './ai-client.js';
import ChatHistory from './chat-history.js';
import ImageGen from './image-gen.js';

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

        client.once(Events.ClientReady, (c) => {
            console.log(`[Bot] 로그인 완료: ${c.user.tag}`);
            console.log(`[Bot] 매핑된 채널: ${Object.keys(config.channels).length}개`);
        });

        client.on(Events.MessageCreate, (message) => this._onMessage(message));

        await client.login(config.discordToken);
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
                return;
            }

            // [SEND_PHOTO: ...] 태그 감지 및 처리
            let photoPrompt = null;
            const photoMatch = response.match(/\[SEND_PHOTO:\s*([^\]]+)\]/s);
            if (photoMatch) {
                photoPrompt = photoMatch[1].trim();
                response = response.replace(photoMatch[0], '').trim();
            }

            // 응답 저장
            ChatHistory.addMessage(message.channelId, 'assistant', response, charName);

            // 웹훅으로 응답 전송
            const webhook = await this._getWebhook(message.channel, character);
            if (webhook) {
                const sendOptions = {
                    content: response,
                    username: charName,
                };

                // 아바타는 웹훅 생성 시 설정된 것을 사용
                // (Discord는 공개 URL만 받으므로 localhost/base64 불가)

                // 이미지 생성 + 첨부
                if (photoPrompt) {
                    try {
                        const imageBuffer = await ImageGen.generate(photoPrompt, character);
                        if (imageBuffer) {
                            const attachment = new AttachmentBuilder(imageBuffer, { name: 'photo.png' });
                            sendOptions.files = [attachment];
                        }
                    } catch (e) {
                        console.error('[Bot] 이미지 생성 실패:', e.message);
                    }
                }

                await webhook.send(sendOptions);
            } else {
                // 웹훅 실패 시 일반 메시지로 폴백
                await message.channel.send(`**${charName}**: ${response}`);
            }

        } catch (e) {
            console.error(`[Bot] 메시지 처리 오류:`, e);
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