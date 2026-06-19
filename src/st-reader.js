import fs from 'fs';
import path from 'path';

let stPath = '';

const STReader = {
    init(configStPath) {
        stPath = configStPath;
        if (!fs.existsSync(stPath)) {
            throw new Error(`SillyTavern 경로를 찾을 수 없습니다: ${stPath}`);
        }
        console.log(`[ST-Reader] SillyTavern 경로: ${stPath}`);
    },

    // --- secrets.json 읽기 ---
    getSecrets() {
        const candidates = [
            path.join(stPath, 'data', 'default-user', 'secrets.json'),
            path.join(stPath, 'secrets.json'),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                return JSON.parse(fs.readFileSync(p, 'utf-8'));
            }
        }
        throw new Error(`secrets.json을 찾을 수 없습니다`);
    },

    // --- settings.json 읽기 ---
    getSettings() {
        const candidates = [
            path.join(stPath, 'data', 'default-user', 'settings.json'),
            path.join(stPath, 'settings.json'),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                return JSON.parse(fs.readFileSync(p, 'utf-8'));
            }
        }
        return {};
    },

    // --- ConnectionManager 프로필 읽기 (챗시폰과 동일한 방식) ---
    getConnectionProfile(profileName) {
        const settings = this.getSettings();
        const cm = settings.extension_settings?.connectionManager;
        if (!cm?.profiles?.length) {
            throw new Error('ConnectionManager 프로필이 없습니다');
        }

        let profile;
        if (profileName) {
            // config에서 이름으로 지정
            profile = cm.profiles.find(p => p.name === profileName || p.id === profileName);
        }
        if (!profile) {
            // ST에서 선택된 프로필 사용
            profile = cm.profiles.find(p => p.id === cm.selectedProfile) || cm.profiles[0];
        }

        if (!profile) throw new Error('사용할 프로필을 찾을 수 없습니다');

        // secret-id로 API 키 가져오기
        const apiKey = this._getSecretByID(profile['secret-id']);

        console.log(`[ST-Reader] 프로필: "${profile.name}" / ${profile.api} / ${profile.model}`);
        return { ...profile, apiKey };
    },

    // secret-id → 실제 API 키 조회
    // secrets.json 구조: api_key_vertexai: [{id, value, label, active}, ...]
    _getSecretByID(secretId) {
        if (!secretId) return null;
        const secrets = this.getSecrets();

        // api_key_* 배열 필드에서 id로 매칭하여 value 추출
        for (const [, val] of Object.entries(secrets)) {
            if (Array.isArray(val)) {
                const entry = val.find(e => e.id === secretId);
                if (entry) return entry.value;
            }
        }

        // 단순 문자열 폴백 (구버전 호환)
        if (typeof secrets[secretId] === 'string') return secrets[secretId];
        return null;
    },

    // 프로필 찾기 (로그 없이)
    _findProfile(profileName) {
        const cm = this.getSettings().extension_settings?.connectionManager;
        if (!cm?.profiles?.length) return null;
        let profile;
        if (profileName) profile = cm.profiles.find(p => p.name === profileName || p.id === profileName);
        if (!profile) profile = cm.profiles.find(p => p.id === cm.selectedProfile) || cm.profiles[0];
        return profile || null;
    },

    // 커넥션 프로필에 연결된 챗컴플리션 프리셋 이름
    getPresetName(profileName) {
        return this._findProfile(profileName)?.preset || '';
    },

    // 프리셋의 활성 프롬프트들을 조립 (마커는 제외 — 캐릭터/페르소나/로어북은 따로 주입하므로)
    // presetName을 직접 받는다 (실제 생성에 쓰는 프로필의 preset과 일치시키기 위해)
    getPresetPromptsByName(presetName) {
        if (!presetName) return '';

        const candidates = [
            path.join(stPath, 'data', 'default-user', 'OpenAI Settings', `${presetName}.json`),
            path.join(stPath, 'public', 'OpenAI Settings', `${presetName}.json`),
        ];
        let preset = null;
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                try { preset = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { /* skip */ }
                break;
            }
        }
        if (!preset?.prompts) {
            console.warn(`[ST-Reader] 프리셋 파일 못 찾음/파싱 실패: ${presetName}`);
            return '';
        }

        const byId = {};
        for (const p of preset.prompts) byId[p.identifier] = p;

        // prompt_order에서 활성 순서 가져오기 (없으면 prompts 순서)
        let entries = null;
        if (Array.isArray(preset.prompt_order) && preset.prompt_order.length) {
            const ord = preset.prompt_order.find(o => o.character_id === 100001)
                || preset.prompt_order[preset.prompt_order.length - 1];
            entries = ord?.order;
        }
        if (!entries) entries = preset.prompts.map(p => ({ identifier: p.identifier, enabled: p.enabled !== false }));

        const parts = [];
        for (const e of entries) {
            if (e.enabled === false) continue;
            const p = byId[e.identifier];
            if (!p || p.marker) continue;          // 마커(chatHistory/charDescription 등)는 스킵
            const c = (p.content || '').trim();
            if (c) parts.push(c);
        }
        if (parts.length) console.log(`[ST-Reader] 프리셋 "${presetName}" 조립 (${parts.length}개 프롬프트)`);
        return parts.join('\n\n');
    },

    getPersonaDescription() {
        const settings = this.getSettings();
        return settings.persona_description || settings.power_user?.persona_description || '';
    },

    // 캐릭터에 ST에서 연결된 페르소나 이름을 자동으로 찾는다.
    // 실제 ST 구조(확인됨): power_user.persona_descriptions[페르소나아바타].connections =
    //   [{ type:'character', id:'캐릭터아바타.png' }, ...]  → 역방향으로 캐릭터→페르소나를 찾음.
    getConnectedPersonaName(character) {
        const pu = this.getSettings().power_user || {};
        const personas = pu.personas || {};            // { 페르소나아바타: 페르소나이름 }
        const descs = pu.persona_descriptions || {};   // { 페르소나아바타: { connections:[...] } }

        const charAvatar = character?.avatar || '';     // 예: "Adonis ‘Baron’ Broussard.png"
        const charName = character?.name || character?.data?.name || '';
        const charAvatarNoExt = charAvatar.replace(/\.[^/.]+$/, '');

        const matchesChar = (id) => {
            if (!id) return false;
            const idNoExt = String(id).replace(/\.[^/.]+$/, '');
            return id === charAvatar || idNoExt === charAvatarNoExt || idNoExt === charName || id === charName;
        };

        // 어떤 페르소나가 이 캐릭터를 connections에 갖고 있나 (먼저 매칭되는 것)
        for (const [personaAvatar, d] of Object.entries(descs)) {
            const conns = d?.connections;
            if (!Array.isArray(conns)) continue;
            const hit = conns.some((c) => c && c.type === 'character' && matchesChar(c.id));
            if (hit) {
                const name = personas[personaAvatar];
                if (name) {
                    console.log(`[ST-Reader] 페르소나 자동연결: ${charName} → ${name}`);
                    return name;
                }
            }
        }
        return '';
    },

    // 이름으로 특정 페르소나 설명 조회 (채널별 페르소나용)
    // ST 구조: power_user.personas = { [avatar]: name }, power_user.persona_descriptions = { [avatar]: { description } }
    getPersonaByName(name) {
        if (!name) return '';
        const pu = this.getSettings().power_user || {};
        const personas = pu.personas || {};
        let avatar = Object.keys(personas).find((k) => personas[k] === name);
        if (!avatar && personas[name] !== undefined) avatar = name; // name이 avatar 키인 경우
        const desc = avatar && pu.persona_descriptions?.[avatar]?.description;
        return desc || '';
    },

    // 페르소나 아바타 이미지 경로 (프록시 웹훅 사진용)
    getPersonaAvatarPath(name) {
        if (!name) return null;
        const pu = this.getSettings().power_user || {};
        const personas = pu.personas || {};
        let avatar = Object.keys(personas).find((k) => personas[k] === name);
        if (!avatar && personas[name] !== undefined) avatar = name;
        if (!avatar) return null;
        const dirs = [
            path.join(stPath, 'data', 'default-user', 'User Avatars', avatar),
            path.join(stPath, 'public', 'User Avatars', avatar),
        ];
        for (const p of dirs) if (fs.existsSync(p)) return p;
        return null;
    },

    // --- 캐릭터 카드 읽기 ---
    getCharactersDir() {
        const dirs = [
            path.join(stPath, 'data', 'default-user', 'characters'),
            path.join(stPath, 'public', 'characters'),
        ];
        for (const dir of dirs) {
            if (fs.existsSync(dir)) return dir;
        }
        throw new Error('캐릭터 디렉토리를 찾을 수 없습니다');
    },

    getCharacter(name) {
        const charDir = this.getCharactersDir();
        const files = fs.readdirSync(charDir);

        // 모든 카드를 읽어 {name, data, avatar} 목록으로 (PNG 우선, JSON 폴백)
        const cards = [];
        for (const file of files.filter(f => f.endsWith('.png'))) {
            try {
                const data = this._readPngCharacterCard(path.join(charDir, file));
                if (!data) continue;
                data.avatar = file;
                cards.push({ charName: data.name || data.data?.name || '', data });
            } catch (e) { /* 깨진 PNG 스킵 */ }
        }
        for (const file of files.filter(f => f.endsWith('.json'))) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(charDir, file), 'utf-8'));
                cards.push({ charName: data.name || data.data?.name || '', data });
            } catch (e) { /* 깨진 JSON 스킵 */ }
        }

        // 1순위: 대소문자까지 정확히 일치
        const exact = cards.find(c => c.charName === name);
        if (exact) return exact.data;

        // 2순위: 대소문자 무시 (정확 일치가 하나도 없을 때만)
        const ci = cards.find(c => c.charName.toLowerCase() === name.toLowerCase());
        if (ci) return ci.data;

        throw new Error(`캐릭터를 찾을 수 없습니다: ${name}`);
    },

    // PNG tEXt 청크에서 'chara' 키의 base64 JSON을 추출
    _readPngCharacterCard(filePath) {
        const buf = fs.readFileSync(filePath);
        // PNG 시그니처 검증 (8바이트)
        if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504E47) return null;

        let offset = 8;
        while (offset + 8 < buf.length) {
            const length = buf.readUInt32BE(offset);
            const type = buf.toString('ascii', offset + 4, offset + 8);
            const dataStart = offset + 8;
            const dataEnd = dataStart + length;

            if (type === 'tEXt' && dataEnd <= buf.length) {
                const chunk = buf.subarray(dataStart, dataEnd);
                const nullIdx = chunk.indexOf(0);
                if (nullIdx !== -1) {
                    const keyword = chunk.toString('ascii', 0, nullIdx);
                    if (keyword === 'chara') {
                        const b64 = chunk.toString('ascii', nullIdx + 1);
                        return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
                    }
                }
            }

            // length(4) + type(4) + data(length) + crc(4)
            offset = dataEnd + 4;
        }
        return null;
    },

    getCharacterAvatarPath(character) {
        if (!character.avatar) return null;
        const charDir = this.getCharactersDir();
        const avatarPath = path.join(charDir, character.avatar);
        if (fs.existsSync(avatarPath)) return avatarPath;
        return null;
    },

    // --- 로어북/월드인포 ---
    getWorldsDir() {
        const dirs = [
            path.join(stPath, 'data', 'default-user', 'worlds'),
            path.join(stPath, 'public', 'worlds'),
        ];
        for (const dir of dirs) {
            if (fs.existsSync(dir)) return dir;
        }
        return null;
    },

    getWorldInfo(worldName) {
        if (!worldName) return [];
        const worldsDir = this.getWorldsDir();
        if (!worldsDir) return [];

        const worldPath = path.join(worldsDir, `${worldName}.json`);
        if (!fs.existsSync(worldPath)) return [];

        try {
            const data = JSON.parse(fs.readFileSync(worldPath, 'utf-8'));
            let entries = [];
            if (data.entries) {
                entries = typeof data.entries === 'object' ? Object.values(data.entries) : data.entries;
            }
            return entries.filter(e => !e.disable && e.content);
        } catch (e) {
            console.error(`[ST-Reader] 월드인포 읽기 실패: ${worldName}`, e.message);
            return [];
        }
    },

    getCharacterBook(character) {
        const charBook = character?.data?.character_book;
        if (!charBook?.entries) return [];
        const entries = typeof charBook.entries === 'object'
            ? Object.values(charBook.entries)
            : charBook.entries;
        return entries.filter(e => !e.disable && e.content);
    },

    getCharacterWorldName(character) {
        return character?.data?.extensions?.world || null;
    },

    // --- CHARM 메모리 ---
    getCharmMemory(charId) {
        // CHARM과 동일한 sanitize: 영숫자, _, - 외 전부 _로 치환
        const safe = String(charId).replace(/[^a-zA-Z0-9_\-]/g, '_');
        const fileName = `charm-memory-${safe}.json`;

        const fileDirs = [
            path.join(stPath, 'data', 'default-user', 'user', 'files'),
            path.join(stPath, 'data', 'default-user', 'files'),
            path.join(stPath, 'public', 'user', 'files'),
        ];

        for (const dir of fileDirs) {
            const filePath = path.join(dir, fileName);
            if (fs.existsSync(filePath)) {
                try {
                    console.log(`[ST-Reader] CHARM 메모리 로드: ${fileName}`);
                    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                } catch (e) {
                    console.error(`[ST-Reader] CHARM 메모리 읽기 실패:`, e.message);
                }
            }
        }
        return null;
    },

    // --- SD 확장 설정 ---
    getSDSettings() {
        const settings = this.getSettings();
        return settings.sd_settings || settings.extension_settings?.sd || null;
    },
};

export default STReader;