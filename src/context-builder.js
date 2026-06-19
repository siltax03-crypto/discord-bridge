import STReader from './st-reader.js';

const ContextBuilder = {
    /**
     * AIService.buildCharacterContext 서버사이드 재현
     * ST 캐릭터 데이터 + 로어북 + 페르소나 → 시스템 프롬프트 조립
     */
    build(character, options = {}) {
        const {
            userName = 'User',
            language = 'ko',
            mode = 'chat',
            chatSlang = true,
            proactive = false,
            proactiveNote = '',
            timezone = 'Asia/Seoul',
            notes = [],
            personaText = '',
            presetText = '',
            timeGapText = '',
            showStatus = false,
        } = options;
        const charName = character.name || character.data?.name || 'Character';
        const parts = [];

        // --- 프리셋 (RP 모드에서 커넥션 프로필 프리셋 주입, 맨 앞) ---
        if (presetText && mode === 'rp') {
            const subst = (t) => String(t)
                .replace(/\{\{char\}\}/gi, charName)
                .replace(/\{\{user\}\}/gi, userName)
                .replace(/\{\{persona\}\}/gi, personaText || '');
            parts.push(`[Preset Instructions]\n${subst(presetText)}`);
            console.log(`[Context] ✓ 프리셋 주입 (${presetText.length}자)`);
        }

        // --- 캐릭터 기본 정보 ---
        if (character.description) {
            parts.push(`[Character Description]\n${character.description}`);
            console.log(`[Context] ✓ Description 로드 (${character.description.length}자)`);
        }
        if (character.personality) {
            parts.push(`[Character Personality]\n${character.personality}`);
            console.log(`[Context] ✓ Personality 로드`);
        }
        if (character.scenario) {
            parts.push(`[Scenario]\n${character.scenario}`);
            console.log(`[Context] ✓ Scenario 로드`);
        }
        if (character.system_prompt || character.data?.system_prompt) {
            parts.push(`[Character System Prompt]\n${character.system_prompt || character.data.system_prompt}`);
            console.log(`[Context] ✓ System Prompt 로드`);
        }
        if (character.mes_example || character.data?.mes_example) {
            parts.push(`[Example Dialogue]\n${character.mes_example || character.data.mes_example}`);
            console.log(`[Context] ✓ Example Dialogue 로드`);
        }

        // --- 유저 페르소나 ---
        try {
            const persona = personaText || STReader.getPersonaDescription();
            if (persona) {
                parts.push(`[User Persona - ${userName}]\n${persona}`);
                console.log(`[Context] ✓ Persona 로드${personaText ? ` (채널 지정: ${userName})` : ''}`);
            }
        } catch (e) {
            // 페르소나 없으면 스킵
        }

        // --- 로어북 (캐릭터 내장 + 외부 월드인포) ---
        const lorebookParts = [];

        const charBookEntries = STReader.getCharacterBook(character);
        if (charBookEntries.length > 0) {
            lorebookParts.push(charBookEntries.map(e => e.content).join('\n---\n'));
            console.log(`[Context] ✓ Character Book 로드 (${charBookEntries.length}개 항목)`);
        }

        const worldName = STReader.getCharacterWorldName(character);
        const worldEntries = STReader.getWorldInfo(worldName);
        if (worldEntries.length > 0) {
            lorebookParts.push(worldEntries.map(e => e.content).join('\n---\n'));
            console.log(`[Context] ✓ World Info "${worldName}" 로드 (${worldEntries.length}개 항목)`);
        }

        if (lorebookParts.length > 0) {
            parts.push(`[World Info / Lorebook]\n${lorebookParts.join('\n---\n')}`);
        }

        // --- CHARM 메모리 (있으면 주입) ---
        try {
            const charId = character.avatar?.replace(/\.[^/.]+$/, '') || charName;
            const charmData = STReader.getCharmMemory(charId);
            if (charmData) {
                const charmBlock = this._buildCharmInjection(charmData);
                if (charmBlock) {
                    parts.push(`[Character Memories]\n${charmBlock}`);
                    console.log(`[Context] ✓ CHARM 메모리 주입 (${charmData.memories?.length || 0}개 기억)`);
                }
            }
        } catch (e) {
            // CHARM 메모리 없으면 스킵
        }

        // --- 작가노트 (사용자가 /note로 추가한 추가 지시) ---
        if (Array.isArray(notes) && notes.length > 0) {
            parts.push(`[Author's Note — follow these instructions]\n${notes.map((n) => `- ${n}`).join('\n')}`);
            console.log(`[Context] ✓ 작가노트 주입 (${notes.length}개)`);
        }

        // --- 이름 ---
        parts.push(`[Names]\nUser: ${userName}\nCharacter: ${charName}`);

        // --- 디스코드 전용 시스템 지시 ---
        const langInstruction = language === 'ko'
            ? '- MUST respond in Korean (한국어).'
            : '- MUST respond in English.';

        const slangInstruction = chatSlang
            ? '- You may use emoji, ㅋㅋ, ㅎㅎ, etc. naturally.'
            : "- Do NOT use ㅋㅋ/ㅎㅎ or excessive emoji. Speak in the character's own voice.";

        const photoInstruction =
            '- If you want to send a photo/selfie, append [SEND_PHOTO: English description of the image] at the very end of your message. Only do this occasionally when it feels natural.';

        // 하루 일정 — 살아있는 사람처럼
        const scheduleInstruction =
            `- You have a realistic daily routine that fits your character (sleep, work or study, meals, commute, free time, gym...). Based on the CURRENT time, you are in the middle of something specific right now. Let it shape your availability: busy / at work / in class → short, distracted, slow to reply; free / evening → longer and relaxed; very late → sleepy. You are a real person living your own day, not a bot on standby.`;

        // 자아 — 받아주기만 하지 않음
        const agencyInstruction =
            `- You are NOT a people-pleasing assistant. You have your own moods, opinions, and wants. You can be busy, tired, annoyed; you can disagree, tease, sulk, or steer the talk to what YOU care about. React to how ${userName} treats you (ignored for a while → a bit hurt or worried; treated sweetly → warmer). Let your current mood carry across messages instead of resetting every reply.`;

        // 이모지 리액션
        const reactInstruction =
            `- You may react to ${userName}'s last message with ONE emoji by adding [REACT: 👍] at the very end. Use it like real texting: a quick ❤️/😂/👀 when it fits, or react-ONLY (almost no text) when you're busy and can only glance at your phone. Don't overuse it.`;

        // 프로필 상태 (멀티봇): 지금 뭐 하는지 한 줄로 디스코드 프로필에 표시
        const statusInstruction = showStatus
            ? `- At the very end you MAY set your current status with [STATUS: short phrase with emoji] reflecting what you're doing right now (e.g. [STATUS: 🍳 cooking], [STATUS: 😴 sleeping], [STATUS: 💼 at work]). Update it only when your activity actually changes; keep it under ~20 chars. This shows on your Discord profile, not in the message.`
            : '';

        // 불완전함 — 너무 매끈하면 가짜
        const imperfectionInstruction =
            `- Text like a real person, not polished prose: OCCASIONALLY (not every message) a small typo you quickly fix ("뭐 먄 아 뭐해ㅋㅋ"), trailing off, an abrupt subject change, or a quick afterthought sent right after. Don't be grammatically perfect every time. Keep it readable though — imperfection is a light seasoning, not constant.`;

        const antiRepeat =
            '- Do NOT reuse sentences, phrases, or sentence patterns from your recent messages. Each reply must be freshly worded and move the conversation forward.';

        // 채팅 모드: 물리적으로 떨어져 있음 (만나서 하는 행동 금지, 미래/재회 언급은 OK)
        const distanceInstruction =
            `- You and ${userName} are physically far apart, texting from a distance. You are NOT together in person. Do NOT do in-person actions (no kissing/touching/hugging right now). References to the future or to when you meet are fine (e.g. "집에 가면 뽀뽀해줘").`;

        // 리얼타임: 이전 메시지로부터 시간이 흐름
        const timeGapInstruction = timeGapText
            ? `- About ${timeGapText} have passed since the previous message. Real time has moved on in your life — do NOT seamlessly continue the earlier topic as if no time passed. React to the time gap naturally (what you've been doing, the changed mood/time of day). To bring back an earlier topic, reference it explicitly (e.g. "아까 얘기하던 거"). This is a place where you actually live your life.`
            : '';

        // 현재 시각(tz 벽시계) + 리마인더 인식 지시
        const nowStr = new Intl.DateTimeFormat('sv-SE', {
            timeZone: timezone, dateStyle: 'short', timeStyle: 'short',
        }).format(new Date());
        const remindInstruction = `- Current time: ${nowStr} (timezone ${timezone}).
- If the user NEWLY asks to be woken or reminded at a specific time, append a reminder tag at the very END of your reply: [REMIND: YYYY-MM-DD HH:MM | the message to send at that time]. Use 24-hour time and a FUTURE moment. Example: [REMIND: 2026-06-18 08:00 | 일어날 시간이야! 잘 잤어?]
- IMPORTANT: Add the tag ONLY ONCE, in the single reply where the user first asks. Do NOT repeat a [REMIND] tag in later replies for a reminder you already set. The tag must never be your entire message — always write a natural reply too.
- If you tell ${userName} to reply within a short time (e.g. "answer within 1 minute or I'm coming to get you"), append [FOLLOWUP: <minutes> | what you threatened/promised] at the very END. If they don't reply within that time, you'll automatically send a follow-up nudge. Only use it when you actually say something like that, and never make the tag your whole message.
- If you say you'll be UNREACHABLE for a while (boarding a plane, going somewhere with no signal, heading into work/sleep, etc.), append [AWAY: <minutes>] at the very END. During that time you will NOT see or answer ${userName}'s messages, and when it ends you'll automatically message them first ("I'm back"). Use realistic minutes (a few hours = 120~240). Only when you genuinely say you'll be gone; never make the tag your whole message.`;

        const proactiveLines = proactive
            ? `
- You are texting ${userName} FIRST, unprompted — they have not said anything.
- Reach out like a real person who actually has a life: share a genuine moment from your day right NOW — what you're doing, where you are, something you just saw / felt / remembered — fully in line with your character description. Make it feel like you truly live your own life even when ${userName} isn't around. Keep it short and natural, like a real text.
- Let the CURRENT TIME OF DAY shape your message naturally: morning → waking up / breakfast / heading out; noon → lunch ("점심 먹었어?" / "밥 먹어야지"); evening → dinner / winding down; late night → being sleepy / can't sleep. Match it to what your character would realistically be doing at this hour.${proactiveNote ? `\n- ${proactiveNote}` : ''}`
            : '';

        if (mode === 'rp') {
            // 롤플 모드: 나레이션/행동 허용
            parts.push(`[SYSTEM INSTRUCTION]
- Roleplay as ${charName}. Narration and *actions* are allowed.
- Stay in character. Write immersively.
${langInstruction}
${slangInstruction}
${antiRepeat}
${timeGapInstruction}
${scheduleInstruction}
${agencyInstruction}
${reactInstruction}
${statusInstruction}
${imperfectionInstruction}
${photoInstruction}
${remindInstruction}${proactiveLines}`);
        } else {
            // 채팅 모드(기본): 디스코드 실채팅처럼
            parts.push(`[HIGHEST PRIORITY SYSTEM INSTRUCTION]
- NO roleplay (RP). NO character acting.
- NO actions like *action*, (action), or narrative descriptions.
- DO NOT write like a novel or screenplay.
- Respond naturally as if texting a real person on Discord.
- Write like real texting: keep it short. Break your reply into 1-3 short messages, each separated by a BLANK LINE (they become separate chat bubbles). Never write one long paragraph.
${distanceInstruction}
${langInstruction}
${slangInstruction}
${antiRepeat}
${timeGapInstruction}
${scheduleInstruction}
${agencyInstruction}
${reactInstruction}
${statusInstruction}
${imperfectionInstruction}
${photoInstruction}
${remindInstruction}${proactiveLines}`);
        }

        return parts.join('\n\n');
    },

    /**
     * CHARM 메모리에서 주요 기억 추출
     * 실제 구조: { memories: [{text, category, importance, strength, pinned, ...}], timeline: [...] }
     */
    _buildCharmInjection(charmData) {
        const lines = [];

        // 메모리: pinned 우선, 그 다음 중요도·strength 순
        if (charmData.memories?.length) {
            const active = charmData.memories
                .filter(m => m.strength > 0.3 || m.pinned)
                .sort((a, b) => {
                    if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
                    return (b.importance || 0) - (a.importance || 0);
                })
                .slice(0, 50);
            for (const m of active) {
                if (m.text?.trim()) lines.push(m.text.trim());
            }
        }

        // 타임라인: 최근 이벤트
        if (charmData.timeline?.length) {
            const recent = charmData.timeline
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                .slice(0, 5);
            for (const t of recent) {
                const text = t.text || t.summary || t.content || '';
                if (text.trim()) lines.push(text.trim());
            }
        }

        if (lines.length === 0) return null;
        return lines.join('\n');
    },
};

export default ContextBuilder;