// 음성 통화 (무료 스택): 디코 음성채널 수신 → PCM→WAV(STT는 bot 쪽에서 Gemini로) / TTS는 edge-tts(무료)
// 세션은 텍스트 채널ID 기준 (그 갠톡의 캐릭터가 통화 상대)
import {
    joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType,
    EndBehaviorType, AudioPlayerStatus, VoiceConnectionStatus, entersState, NoSubscriberBehavior,
} from '@discordjs/voice';
import prism from 'prism-media';
import { Readable } from 'stream';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const sessions = {}; // { textChannelId: session }

const VoiceCall = {
    active(channelId) { return sessions[channelId] || null; },
    allSessions() { return Object.values(sessions); },

    // 통화 시작: 음성채널 접속 + 유저 발화 수신 루프
    // onUtterance(wavBuffer): 한 번의 발화(침묵으로 끊김)가 끝날 때마다 호출 (STT/응답은 호출측)
    async start({ voiceChannel, textChannel, channelId, userId, voiceName, onUtterance, onEnd, character = null, userName = '' }) {
        if (sessions[channelId]) throw new Error('이미 통화 중이에요');
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false,
            debug: true,
        });
        connection.on('stateChange', (o, n) => console.log(`[Call] 연결 상태: ${o.status} → ${n.status}`));
        connection.on('error', (e) => console.warn('[Call] 연결 오류:', e.message));
        connection.on('debug', (m) => console.log('[Call:debug]', String(m).slice(0, 300)));
        try { await entersState(connection, VoiceConnectionStatus.Ready, 20_000); }
        catch (e) {
            const st = connection.state?.status;
            try { connection.destroy(); } catch { /* 무시 */ }
            throw new Error(`음성채널 연결 실패 (상태: ${st}): ${e.message}`);
        }

        const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        connection.subscribe(player);

        const s = sessions[channelId] = {
            connection, player, voiceChannel, textChannel, channelId, userId, voiceName,
            onUtterance, onEnd, character, userName,
            recording: false, generating: false, pendingText: false,
            greeted: false, joinTimer: null,
            speakQueue: Promise.resolve(), ended: false,
        };

        // 유저 발화 수신: 말 시작 → 침묵 900ms까지 녹음 → WAV 콜백
        const receiver = connection.receiver;
        receiver.speaking.on('start', (uid) => {
            if (s.ended || uid !== userId) return;
            // 유저가 말 시작하면 봇 음성 즉시 멈춤 (말 끊고 들어가기)
            try { s.player.stop(true); } catch { /* 무시 */ }
            if (s.recording) return;
            s.recording = true;
            const opus = receiver.subscribe(uid, { end: { behavior: EndBehaviorType.AfterSilence, duration: 900 } });
            const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
            const chunks = [];
            opus.pipe(decoder);
            decoder.on('data', (c) => chunks.push(c));
            const finish = () => {
                if (!s.recording) return;
                s.recording = false;
                const pcm = Buffer.concat(chunks);
                // 0.35초 미만(숨소리/노이즈)은 버림 — 48kHz 스테레오 16bit = 초당 192,000바이트
                if (pcm.length < 192_000 * 0.35) return;
                const wav = this._pcmToWav16k(pcm);
                Promise.resolve(onUtterance(wav)).catch((e) => console.warn('[Call] 발화 처리 오류:', e.message));
            };
            decoder.once('end', finish);
            decoder.once('error', (e) => { s.recording = false; console.warn('[Call] 디코드 오류:', e.message); });
            opus.once('error', (e) => { s.recording = false; console.warn('[Call] 수신 오류:', e.message); });
        });

        connection.on(VoiceConnectionStatus.Disconnected, () => {
            if (!s.ended) this.end(channelId, '연결이 끊겼어요');
        });
        return s;
    },

    // 48kHz 스테레오 s16le PCM → 16kHz 모노 WAV (좌우 평균 + 3샘플당 1개 데시메이션)
    _pcmToWav16k(stereo48k) {
        const samples = Math.floor(stereo48k.length / 4); // 2ch × 2byte
        const outN = Math.floor(samples / 3);
        const out = Buffer.alloc(outN * 2);
        for (let i = 0; i < outN; i++) {
            const si = i * 3 * 4;
            const l = stereo48k.readInt16LE(si);
            const r = stereo48k.readInt16LE(si + 2);
            out.writeInt16LE(Math.max(-32768, Math.min(32767, (l + r) >> 1)), i * 2);
        }
        const h = Buffer.alloc(44);
        h.write('RIFF', 0); h.writeUInt32LE(36 + out.length, 4); h.write('WAVE', 8);
        h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
        h.writeUInt32LE(16000, 24); h.writeUInt32LE(16000 * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
        h.write('data', 36); h.writeUInt32LE(out.length, 40);
        return Buffer.concat([h, out]);
    },

    // 텍스트를 edge-tts로 합성해 재생 (순서 보장 큐)
    async speak(channelId, text) {
        const s = sessions[channelId];
        if (!s || s.ended || !text) return;
        s.speakQueue = s.speakQueue.then(() => this._speakNow(s, text)).catch((e) => console.warn('[Call] TTS 오류:', e?.message || e, e?.stack?.split('\n')[1] || ''));
        return s.speakQueue;
    },

    async _speakNow(s, text) {
        if (s.ended) return;
        const tts = new MsEdgeTTS();
        // WebM/Opus 포맷이면 ffmpeg 없이 디코 재생 가능
        await tts.setMetadata(s.voiceName, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
        const r = await tts.toStream(text);
        const stream = r?.audioStream || r; // msedge-tts 버전에 따라 {audioStream} 또는 Readable
        // MS 서버가 실시간보다 느리게 흘려주면 재생이 음절 단위로 끊기고 중간에 멈춤 → 전부 받아서 한 번에 재생
        const buf = await new Promise((resolve, reject) => {
            const chunks = [];
            stream.on('data', (c) => chunks.push(c));
            stream.once('end', () => resolve(Buffer.concat(chunks)));
            stream.once('error', reject);
        });
        if (s.ended || !buf.length) return;
        const resource = createAudioResource(Readable.from(buf), { inputType: StreamType.WebmOpus });
        s.player.play(resource);
        await entersState(s.player, AudioPlayerStatus.Playing, 10_000).catch(() => {});
        await new Promise((resolve) => {
            const done = () => resolve();
            s.player.once(AudioPlayerStatus.Idle, done);
            s.player.once('error', done);
        });
    },

    end(channelId, reason = '') {
        const s = sessions[channelId];
        if (!s) return false;
        s.ended = true;
        if (s.joinTimer) { clearTimeout(s.joinTimer); s.joinTimer = null; }
        try { s.player.stop(true); } catch { /* 무시 */ }
        try { s.connection.destroy(); } catch { /* 무시 */ }
        delete sessions[channelId];
        try { s.onEnd?.(reason); } catch { /* 무시 */ }
        return true;
    },
};

export default VoiceCall;
