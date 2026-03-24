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

    getPersonaDescription() {
        const settings = this.getSettings();
        return settings.persona_description || settings.power_user?.persona_description || '';
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

        // 1) PNG 캐릭터 카드에서 읽기 (ST 기본 형식)
        for (const file of files.filter(f => f.endsWith('.png'))) {
            try {
                const data = this._readPngCharacterCard(path.join(charDir, file));
                if (!data) continue;
                const charName = data.name || data.data?.name || '';
                if (charName === name || charName.toLowerCase() === name.toLowerCase()) {
                    data.avatar = file; // 아바타 경로 보존
                    return data;
                }
            } catch (e) {
                // PNG 파싱 실패한 파일은 스킵
            }
        }

        // 2) JSON 폴백 (구버전 호환)
        for (const file of files.filter(f => f.endsWith('.json'))) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(charDir, file), 'utf-8'));
                const charName = data.name || data.data?.name || '';
                if (charName === name || charName.toLowerCase() === name.toLowerCase()) {
                    return data;
                }
            } catch (e) {
                // JSON 파싱 실패한 파일은 스킵
            }
        }
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