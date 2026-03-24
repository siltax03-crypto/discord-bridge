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
        }
        if (character.personality) {
            parts.push(`[Character Personality]\n${character.personality}`);
        }
        if (character.scenario) {
            parts.push(`[Scenario]\n${character.scenario}`);
        }
        if (character.system_prompt || character.data?.system_prompt) {
            parts.push(`[Character System Prompt]\n${character.system_prompt || character.data.system_prompt}`);
        }
        if (character.mes_example || character.data?.mes_example) {
            parts.push(`[Example Dialogue]\n${character.mes_example || character.data.mes_example}`);
        }

        // --- 유저 페르소나 ---
        try {
            const persona = STReader.getPersonaDescription();
            if (persona) {
                parts.push(`[User Persona - ${userName}]\n${persona}`);
            }
        } catch (e) {
            // 페르소나 없으면 스킵
        }

        // --- 로어북 (캐릭터 내장 + 외부 월드인포) ---
        const lorebookParts = [];

        const charBookEntries = STReader.getCharacterBook(character);
        if (charBookEntries.length > 0) {
            lorebookParts.push(charBookEntries.map(e => e.content).join('\n---\n'));
        }

        const worldName = STReader.getCharacterWorldName(character);
        const worldEntries = STReader.getWorldInfo(worldName);
        if (worldEntries.length > 0) {
            lorebookParts.push(worldEntries.map(e => e.content).join('\n---\n'));
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
     * CHARM 메모리에서 주요 기억 추출 (간소화 버전)
     * 중요도 높은 기억 + 최근 기억 위주
     */
    _buildCharmInjection(charmData) {
        const memories = [];

        // Tier 3: 감정 카테고리 기억
        if (charmData.tier3) {
            const categories = ['heart', 'habit', 'promise', 'surprise', 'wound', 'first', 'inside'];
            for (const cat of categories) {
                const items = charmData.tier3[cat] || [];
                const active = items
                    .filter(m => m.strength > 0.3 || m.pinned)
                    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
                    .slice(0, 3);
                for (const m of active) {
                    memories.push(m.text || m.content || '');
                }
            }
        }

        // Tier 2: 타임라인 (최근 항목)
        if (charmData.tier2?.timeline) {
            const recent = charmData.tier2.timeline
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                .slice(0, 5);
            for (const m of recent) {
                memories.push(m.text || m.content || m.summary || '');
            }
        }

        const valid = memories.filter(m => m.trim());
        if (valid.length === 0) return null;
        return valid.join('\n');
    },
};

export default ContextBuilder;