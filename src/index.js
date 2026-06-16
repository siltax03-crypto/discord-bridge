import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import STReader from './st-reader.js';
import AIClient from './ai-client.js';
import ChatHistory from './chat-history.js';
import Bot from './bot.js';
import ImageGen from './image-gen.js';
import Scheduler from './scheduler.js';
import Reminders from './reminders.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- 로그에 타임스탬프 추가 ---
const _origLog = console.log;
const _origErr = console.error;
const _origWarn = console.warn;
const _ts = () => new Date().toLocaleTimeString('ko-KR', { hour12: false });
console.log = (...args) => _origLog(`[${_ts()}]`, ...args);
console.error = (...args) => _origErr(`[${_ts()}]`, ...args);
console.warn = (...args) => _origWarn(`[${_ts()}]`, ...args);

// --- config.json 로드 ---
const configPath = path.join(__dirname, '..', 'config.json');
const examplePath = path.join(__dirname, '..', 'config.example.json');
if (!fs.existsSync(configPath)) {
    // 최초 실행/업데이트 직후: 예시 파일로부터 생성
    if (fs.existsSync(examplePath)) {
        fs.copyFileSync(examplePath, configPath);
        console.log('config.json이 없어 config.example.json으로 생성했습니다. ST 설정 화면에서 값을 채우세요.');
    } else {
        console.error('config.json을 찾을 수 없습니다.');
        process.exit(1);
    }
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// --- stPath 자동 보정 ---
// 설정이 없거나 경로가 존재하지 않으면, 형제 폴더의 SillyTavern을 자동으로 찾는다.
// (discord-bridge와 SillyTavern이 같은 부모 폴더 안에 나란히 있다고 가정)
const siblingST = path.join(__dirname, '..', '..', 'SillyTavern');
if ((!config.stPath || !fs.existsSync(config.stPath)) && fs.existsSync(siblingST)) {
    config.stPath = siblingST;
    console.log(`[Init] stPath 자동 설정 (형제 폴더): ${siblingST}`);
}

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

    // --- 선톡 스케줄러 + 리마인더 ---
    const sendProactive = (channelId, note) => Bot.sendProactive(channelId, note);
    Scheduler.init(config, sendProactive);
    Reminders.init(config, sendProactive);
    console.log('[Init] 스케줄러/리마인더 설정 완료');

    // --- heartbeat: ST 확장 설정 UI에서 봇 상태 표시용 ---
    const statusPath = path.join(__dirname, '..', 'data', 'bot-status.json');
    const writeHeartbeat = () => {
        try {
            fs.writeFileSync(statusPath, JSON.stringify({ ts: Date.now(), pid: process.pid }));
        } catch { /* 무시 */ }
    };
    writeHeartbeat();
    setInterval(writeHeartbeat, 30_000).unref();

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