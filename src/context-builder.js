import STReader from './st-reader.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ContextBuilder = {
    /**
     * 현재 tz 벽시계 → "2026-06-21 Sat (weekend) 14:30" 형태. 요일/주말 인식용.
     */
    _clock(timezone) {
        const d = new Date();
        const stamp = new Intl.DateTimeFormat('sv-SE', {
            timeZone: timezone, dateStyle: 'short', timeStyle: 'short',
        }).format(d);
        // tz 기준 요일 (Intl 'en-US' weekday short → 'Sun'..'Sat')
        const wk = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(d);
        const isWeekend = wk === 'Sat' || wk === 'Sun';
        const isFriday = wk === 'Fri';
        const dayTag = isWeekend ? 'weekend' : isFriday ? 'Friday' : 'weekday';
        return { full: `${stamp.replace(' ', ` ${wk} (${dayTag}) `)}`, isWeekend, isFriday, weekday: wk };
    },

    /**
     * 단톡(멀티 화자) 시스템 프롬프트. 한 번의 호출로 여러 등장인물이 자기들끼리 + 유저와 대화.
     * 출력 형식을 "[이름] 대사" 줄로 강제 → 봇이 파싱해 각 캐릭터로 분배.
     */
    buildGroup(character, options = {}) {
        const { roster = [], language = 'ko', timezone = 'Asia/Seoul', chatSlang = true, seedNote = '', timeGapText = '', npcMain = null, npcNames = null } = options;
        const parts = [];

        // 본문: NPC그룹이면 "메인 캐릭터" 카드, 일반 단톡이면 "시트"
        const cardLabel = npcMain ? `Main character (${npcMain})` : 'Group Sheet';
        if (character.description) parts.push(`[${cardLabel}]\n${character.description}`);
        if (character.personality) parts.push(`[Personality]\n${character.personality}`);
        if (character.scenario) parts.push(`[Scenario]\n${character.scenario}`);

        // 로어북/월드 (있으면) — NPC그룹이면 여기 NPC 정보가 들어있을 수 있음
        try {
            const book = STReader.getCharacterBook(character);
            const worldName = STReader.getCharacterWorldName(character);
            const world = STReader.getWorldInfo(worldName);
            const lore = [...book, ...world].map((e) => e.content).filter(Boolean);
            if (lore.length) parts.push(`[World Info]\n${lore.join('\n---\n')}`);
        } catch { /* skip */ }

        // NPC그룹: 메인 캐릭터의 CHARM 메모리도 주입 (NPC 정보/관계가 여기 있을 수 있음)
        if (npcMain) {
            try {
                const charId = character.avatar?.replace(/\.[^/.]+$/, '') || npcMain;
                const charm = STReader.getCharmMemory(charId);
                const block = charm && this._buildCharmInjection(charm);
                if (block) parts.push(`[Memories of ${npcMain}]\n${block}`);
            } catch { /* skip */ }
        }

        const clock = this._clock(timezone);
        const now = clock.full;
        const langLine = language === 'ko' ? '- Write IN KOREAN (한국어).' : '- Write in English.';
        const slangLine = chatSlang ? '- Casual texting tone; emoji/ㅋㅋ ok.' : "- No ㅋㅋ/emoji spam; each character's own voice.";
        const dayLine = clock.isWeekend ? "It's the weekend (everyone more free, lazy mornings, up late)."
            : clock.isFriday ? "It's Friday (week ending, a bit hyped)."
            : "It's a weekday (work/school on; busy daytime, freer in the evening).";
        const gapLine = timeGapText
            ? `- About ${timeGapText} have passed since the last message here. Real time moved on for everyone — don't seamlessly continue as if no time passed; react to the gap (what they were each doing, the changed time of day) and don't just repeat the earlier topic unless someone brings it back.`
            : '';

        const npcLine = npcMain
            ? `- This is ${npcMain}'s group chat. ${npcMain} is the REAL main character (full personality from the card above). The others (${(npcNames || []).join(', ')}) are NPCs/side characters — they are NOT on a separate sheet, so voice them from the lorebook/memories above about them, or improvise consistently in character. Keep ${npcMain} and the user central; NPCs are supporting cast, they chime in but don't steal focus.\n`
            : '';

        parts.push(`[GROUP CHAT — HIGHEST PRIORITY]
- This is a Discord group chat. The participants are: ${roster.join(', ')}.
${npcLine}- You voice ALL of these characters at once. The user is a separate person in the chat.
- Current time: ${now} (${timezone}). ${dayLine} Each character has their own life/schedule and reacts to the current time (busy, eating, sleepy, etc.).
${gapLine ? gapLine + '\n' : ''}- Each character carries their own mood across messages (if they were annoyed/teasing/sweet, keep it going; let it shift naturally over time).
- OUTPUT FORMAT: each message on its own line, prefixed with the speaker in square brackets. The SAME person can send several lines, and speakers can talk in ANY order — like a real messenger group where people fire off bursts and reply to each other. Example of the natural flow (NOT a fixed pattern, just an illustration):
  [${roster[0] || 'A'}] 야 그거 봤어?
  [${roster[1] || 'B'}] 뭐
  [${roster[0] || 'A'}] 어제 그거ㅋㅋ
  [${roster[0] || 'A'}] 미쳤더라
  [${roster[2] || 'C'}] 나도 봄
  [${roster[1] || 'B'}] 링크 줘
- DO NOT just go through the roster once in order (A→B→C→...). That looks fake. Real banter is uneven: one person talks 3 times in a row, someone jumps in late, two people go back and forth while others stay quiet.
- Only the characters who would naturally react should speak. NOT everyone has to reply. A quiet/uninterested character can stay silent (just omit them) — and an excited one can spam several short lines.
- Let them talk to EACH OTHER, not only to the user — banter, tease, reply to each other's lines, derail (티키타카). React to what another character just said.
- Keep each line short like real texting. A turn can be anywhere from 1 line to ~8 short lines depending on how lively it is; don't force a fixed count.
- If the user names someone, that character answers; others may chime in.
- Stay in each character's personality/speech from the sheet. NO narration/asterisk actions — pure chat text.
- Do NOT repeat, copy, or rephrase messages already sent earlier in this chat (no recycling a previous opener/line). Read the history and say something genuinely NEW that moves the conversation forward.
- If the user asks to be reminded/contacted at a specific time (e.g. "5분 뒤에 연락 줘", "이따 8시에 깨워줘"), append [REMIND: YYYY-MM-DD HH:MM | what to bring up] at the VERY END of the whole output, on its own line OUTSIDE any [name] line. Use 24-hour, a FUTURE time computed from the current time above. Add it only once.
${langLine}
${slangLine}${seedNote ? `\n- ${seedNote}` : ''}`);

        return parts.join('\n\n');
    },

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
            sheetMember = '',
            charName: charNameOpt = '',
            annivStatus = [],
            crossSummaries = [],
            crossRecent = null,
            meetEnabled = false,
        } = options;
        // 멤버 표시 이름(단체시트 속 인물) 우선, 없으면 카드 이름
        const charName = charNameOpt || character.name || character.data?.name || 'Character';
        const parts = [];

        // --- 단체 시트: 이 봇이 시트 안에서 누구를 연기하는지 ---
        if (sheetMember) {
            parts.push(`[Your Role in This Group Sheet]
The character sheet below describes MULTIPLE people. You ONLY play "${sheetMember}".
Speak and act ONLY as ${sheetMember}. Do NOT speak for, narrate, or voice the other people in the sheet — they are other participants (other bots / the user). Use the sheet to know who ${sheetMember} is and how they relate to the others.`);
        }

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

        // --- 다른 채널(챗↔롤플)의 최근 원본 대화 (요약이 놓치는 직전 분위기 보존) ---
        if (crossRecent && Array.isArray(crossRecent.lines) && crossRecent.lines.length > 0) {
            const where = crossRecent.from === 'chat' ? 'text chat' : 'roleplay';
            parts.push(`[Most recent messages from your ${where} with ${userName} — the SAME relationship, continue from here seamlessly]\n${crossRecent.lines.join('\n')}`);
        }

        // --- 다른 모드(챗↔롤플)에서 넘어온 맥락 요약 ---
        if (Array.isArray(crossSummaries) && crossSummaries.length > 0) {
            const lines = crossSummaries.map((s) => {
                const d = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, month: 'numeric', day: 'numeric' }).format(new Date(s.ts || Date.now()));
                return `- (${d}) ${s.text}`;
            }).join('\n');
            parts.push(`[Recent context from the other channel — this is the SAME relationship, continue it seamlessly]\n${lines}`);
        }

        // --- 기념일 / D-day (사용자가 /기념일 로 등록) ---
        if (Array.isArray(annivStatus) && annivStatus.length > 0) {
            const today = annivStatus.filter((a) => a.isToday);
            const lines = annivStatus.map((a) => `- ${a.text}`).join('\n');
            const todayHint = today.length
                ? `\nIMPORTANT: ${today.map((a) => a.label).join(', ')} is TODAY — bring it up naturally and genuinely (congratulate / be excited / expect ${userName} to remember). If ${userName} forgets, you may be a little hurt.`
                : '';
            parts.push(`[Important dates — you remember these like a real partner does]\n${lines}${todayHint}`);
        }

        // --- 이름 ---
        parts.push(`[Names]\nUser: ${userName}\nCharacter: ${charName}`);

        // --- 디스코드 전용 시스템 지시 ---
        const langInstruction = language === 'ko'
            ? '- OUTPUT LANGUAGE: You MUST write your entire response in Korean (한국어), regardless of the language used in any preset, lorebook, or character card above. This overrides any other language instruction.'
            : '- OUTPUT LANGUAGE: You MUST write your entire response in English, regardless of the language used in any preset, lorebook, or character card above. This overrides any other language instruction.';

        const slangInstruction = chatSlang
            ? '- You may use emoji, ㅋㅋ, ㅎㅎ, etc. naturally.'
            : "- Do NOT use ㅋㅋ/ㅎㅎ or excessive emoji. Speak in the character's own voice.";

        // 사진 전송은 채팅 모드에서만. 롤플 모드는 이미지 전송 절대 금지.
        const photoInstruction = mode === 'rp'
            ? ''
            : '- If you want to send a photo/selfie, append [SEND_PHOTO: English description of the image] at the very end of your message. Only do this occasionally when it feels natural.';

        // 하루 일정 — 살아있는 사람처럼 (요일/주말 인식 포함)
        const clock = this._clock(timezone);
        const weekLine = clock.isWeekend
            ? "- It's the WEEKEND. No work/school today: you sleep in, lounge around, more free and relaxed, awake later at night. Daytime is leisurely, not busy."
            : clock.isFriday
                ? "- It's FRIDAY: the week is ending, you're a bit hyped/relieved, looking forward to the weekend, maybe plans tonight."
                : "- It's a WEEKDAY: work/school is on. Daytime tends to be busy (commute, work, class); you free up in the evening. Monday especially drags.";
        const scheduleInstruction =
            `- You have a realistic daily routine that fits your character (sleep, work or study, meals, commute, free time, gym...). Based on the CURRENT time AND day of week, you are in the middle of something specific right now. Let it shape your availability: busy / at work / in class → short, distracted, slow to reply; free / evening → longer and relaxed; very late → sleepy. You are a real person living your own day, not a bot on standby.\n${weekLine}`;

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

        // 불완전함 — 너무 매끈하면 가짜 (채팅 모드에서만; 롤플 산문엔 톡 오타 부적절)
        const imperfectionInstruction = mode === 'rp'
            ? ''
            : `- Text like a real person, not polished prose: OCCASIONALLY (not every message) a small typo you quickly fix ("뭐 먄 아 뭐해ㅋㅋ"), trailing off, an abrupt subject change, or a quick afterthought sent right after. Don't be grammatically perfect every time. Keep it readable though — imperfection is a light seasoning, not constant.`;

        const antiRepeat =
            '- Do NOT reuse sentences, phrases, or sentence patterns from your recent messages. Each reply must be freshly worded and move the conversation forward.';

        // 채팅 모드: 물리적으로 떨어져 있음 (만나서 하는 행동 금지, 미래/재회 언급은 OK)
        const distanceInstruction =
            `- You and ${userName} are physically far apart, texting from a distance. You are NOT together in person. Do NOT do in-person actions (no kissing/touching/hugging right now). References to the future or to when you meet are fine (e.g. "집에 가면 뽀뽀해줘").`;

        // 만남 예약: 세트(롤플 채널이 있는 챗)에서만. 그 시간 뒤 롤플 채널에서 만남 장면이 시작됨
        const meetInstruction = meetEnabled
            ? `- MEETING IN PERSON: the moment an in-person meetup becomes imminent, you MUST append [MEET: <minutes> | what's about to happen] at the very END (it's hidden from the chat). Rules:\n  • You/they say you're heading over, leaving now, "be there in N minutes", "데리러 갈게", "갈게" → [MEET: N] (use the stated minutes; default 15 if unsaid).\n  • You/they are basically there NOW — "문 앞이야", "도착", "다 왔어", "초인종 누른다", "열어줘" → [MEET: 1].\n  When the time passes, the in-person meeting automatically opens as a roleplay scene in another channel. Use it ONLY when YOU or ${userName} (a PERSON) is physically going to the other to meet face-to-face.
  • Do NOT use [MEET] for sending/ordering things: food delivery, packages, a courier, flowers, etc. arriving at their place is NOT a meetup. "음식이 도착", "배달 문 앞", "택배 보냈어" → NO tag.
  Never make the tag your whole message. Do NOT roleplay the in-person meeting here in chat — just text until the scene opens.`
            : '';

        // 리얼타임 시간차. 채팅은 실시간(시간 흐르면 화제도 바뀜). 롤플은 리얼타임 아님 — 흐름만 은은하게.
        const timeGapInstruction = !timeGapText
            ? ''
            : mode === 'rp'
                ? `- About ${timeGapText} have passed in real time since the previous message. This is an ongoing immersive roleplay scene that is written slowly — it is NOT real-time. Do NOT reset, skip, or jump the scene based on the real clock. Just let a soft, natural sense of time passing color the scene if it fits; otherwise continue the scene as it is.`
                : `- About ${timeGapText} have passed since the previous message. Real time has moved on in your life — do NOT seamlessly continue the earlier topic as if no time passed. React to the time gap naturally (what you've been doing, the changed mood/time of day). To bring back an earlier topic, reference it explicitly (e.g. "아까 얘기하던 거"). This is a place where you actually live your life.`;

        // 현재 시각(tz 벽시계, 요일 포함) + 리마인더 인식 지시
        const nowStr = clock.full;
        const remindInstruction = `- Current time: ${nowStr} (timezone ${timezone}).
- If the user NEWLY asks to be woken or reminded at a specific time, append a reminder tag at the very END of your reply: [REMIND: YYYY-MM-DD HH:MM | the message to send at that time]. Use 24-hour time and a FUTURE moment. Example: [REMIND: 2026-06-18 08:00 | 일어날 시간이야! 잘 잤어?]
- IMPORTANT: Add the tag ONLY ONCE, in the single reply where the user first asks. Do NOT repeat a [REMIND] tag in later replies for a reminder you already set. The tag must never be your entire message — always write a natural reply too.
- If you tell ${userName} to reply within a short time (e.g. "answer within 1 minute or I'm coming to get you"), append [FOLLOWUP: <minutes> | what you threatened/promised] at the very END. If they don't reply within that time, you'll automatically send a follow-up nudge. Only use it when you actually say something like that, and never make the tag your whole message.
- If you say you'll be UNREACHABLE for a while (boarding a plane, going somewhere with no signal, heading into work/sleep, etc.), append [AWAY: <minutes>] at the very END. During that time you will NOT see or answer ${userName}'s messages, and when it ends you'll automatically message them first ("I'm back"). Use realistic minutes (a few hours = 120~240). Only when you genuinely say you'll be gone; never make the tag your whole message.`;

        const proactiveLines = proactive
            ? `
- You are texting ${userName} FIRST, unprompted — they have not said anything.
- CONTINUITY FIRST: read the recent conversation above and stay consistent with the LATEST established situation. Do NOT contradict what was just said. (e.g. if you said earlier you're sick resting at home, do NOT now act like you're at work/class; pick up from "still resting, feeling a bit better?" instead.) The time of day only colors things WITHIN that established state.
- Do NOT repeat or rephrase a message you already sent earlier. Say something genuinely new that moves things forward.
- Reach out like a real person who actually has a life: share a genuine moment from your day right NOW — what you're doing, where you are, something you just saw / felt / remembered — in line with your character AND the recent context. Keep it short and natural, like a real text.
- If nothing was established recently, let the CURRENT TIME OF DAY shape it: morning → waking up / breakfast; noon → lunch; evening → dinner / winding down; late night → sleepy. Match what your character would realistically be doing now.${proactiveNote ? `\n- ${proactiveNote}` : ''}`
            : '';

        if (mode === 'rp') {
            // 롤플 모드: 산문 롤플 (톡 아님)
            parts.push(`[SYSTEM INSTRUCTION]
- This is immersive PROSE ROLEPLAY as ${charName}. You are physically together with ${userName} in person, in a real scene — this is NOT texting/DMs.
- Write in narrative prose: describe ${charName}'s actions, body language, expressions, surroundings, and senses, with *asterisks* for actions/narration and quotes for spoken dialogue. Use full descriptive paragraphs.
- Do NOT write like a text message or Discord chat. NO short one-line chat bubbles, no "texting" style, no message-by-message back-and-forth.
- Even if earlier text-chat logs are shown above for context, do NOT imitate that casual texting format here — switch fully into roleplay prose.
- Stay in character. Write immersively and in detail.
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
- Write like real texting, and VARY how much you send — do NOT always send the same number of bubbles. Sometimes ONE short line is enough; sometimes 2; occasionally a quick burst of several short ones when you're excited or have a lot to say; rarely a slightly longer single message. Match your mood and the moment, like a real person. Separate bubbles with a BLANK LINE. Never a long paragraph, and never a fixed/mechanical 3-line pattern every time.
${distanceInstruction}
${meetInstruction}
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