import STReader from './st-reader.js';

const ContextBuilder = {
    /**
     * AIService.buildCharacterContext 서버사이드 재현
     * ST 캐릭터 데이터 + 로어북 + 페르소나 → 시스템 프롬프트 조립
     */
    build(character, options = {}) {
        const { userName = 'User', language = 'ko' } = options;
        const charName = character.name || character.data?.name || 'Character';
        const parts = [];

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
            const persona = STReader.getPersonaDescription();
            if (persona) {
                parts.push(`[User Persona - ${userName}]\n${persona}`);
                console.log(`[Context] ✓ Persona 로드`);
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

        // --- 이름 ---
        parts.push(`[Names]\nUser: ${userName}\nCharacter: ${charName}`);

        // --- 디스코드 전용 시스템 지시 ---
        const langInstruction = language === 'ko'
            ? '- MUST respond in Korean (한국어).'
            : '- MUST respond in English.';

        parts.push(`[HIGHEST PRIORITY SYSTEM INSTRUCTION]
- NO roleplay (RP). NO character acting.
- NO actions like *action*, (action), or narrative descriptions.
- DO NOT write like a novel or screenplay.
- Respond naturally as if chatting on Discord.
${langInstruction}
- Keep messages concise. Use short sentences.
- You may use emoji, ㅋㅋ, ㅎㅎ, etc. naturally.
- If you want to send a photo/selfie, append [SEND_PHOTO: English description of the image] at the very end of your message. Only do this occasionally when it feels natural.`);

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
                .slice(0, 20);
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