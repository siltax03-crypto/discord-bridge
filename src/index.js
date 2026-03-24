import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import STReader from './st-reader.js';
import AIClient from './ai-client.js';
import ChatHistory from './chat-history.js';
import Bot from './bot.js';
import ImageGen from './image-gen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- config.json 로드 ---
const configPath = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
    console.error('config.json을 찾을 수 없습니다.');
    process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// --- 유효성 검사 ---
if (!config.stPath) {
    console.error('config.json에 stPath를 설정해주세요.');
    process.exit(1);
}
if (!config.discordToken || config.discordToken.includes('여기에')) {
    console.error('config.json에 discordToken을 설정해주세요.');
    process.exit(1);
}
if (!config.channels || Object.keys(config.channels).length === 0) {
    console.error('config.json에 channels를 설정해주세요.');
    process.exit(1);
}

// --- 모듈 초기화 ---
console.log('=== Discord Bridge 시작 ===');

try {
    STReader.init(config.stPath);
    console.log('[Init] ST 경로 확인 완료');

    // ConnectionManager 프로필로 API 자동 설정
    AIClient.init(config);
    console.log('[Init] API 설정 완료');

    // 캐릭터 매핑 확인
    for (const [channelId, channelConfig] of Object.entries(config.channels)) {
        try {
            const char = STReader.getCharacter(channelConfig.character);
            console.log(`[Init] 채널 ${channelId} → ${char.name || channelConfig.character} ✓`);
        } catch (e) {
            console.warn(`[Init] 채널 ${channelId} → ${channelConfig.character}: ${e.message}`);
        }
    }

    ChatHistory.init(config);
    ImageGen.init(config);

    // --- 봇 시작 ---
    await Bot.start(config);

} catch (e) {
    console.error('[Init] 시작 실패:', e.message);
    process.exit(1);
}

// --- 종료 처리 ---
process.on('SIGINT', async () => {
    console.log('\n종료 중...');
    await Bot.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await Bot.stop();
    process.exit(0);
});