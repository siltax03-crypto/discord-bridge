import fs from 'fs';
import STReader from './st-reader.js';

let config = {};
let apiKey = null;

const ImageGen = {
    init(cfg) {
        config = cfg;
        // ConnectionManager 프로필에서 API 키 재사용
        const profile = STReader.getConnectionProfile(cfg.connectionProfile);
        apiKey = profile.apiKey;
    },

    /**
     * Vertex AI Imagen API로 직접 이미지 생성
     * 캐릭터 PNG를 subject reference로 포함하여 외모 일관성 유지
     */
    async generate(scenePrompt, character) {
        if (!apiKey) throw new Error('Imagen API 키가 없습니다');

        // 캐릭터 description에서 외모+성격 키워드 추출하여 프롬프트 보강
        const charDesc = this._buildCharacterPrefix(character);
        const fullPrompt = charDesc ? `${charDesc}. ${scenePrompt}` : scenePrompt;
        console.log(`[ImageGen] 프롬프트: ${fullPrompt.substring(0, 150)}...`);

        // 캐릭터 PNG를 레퍼런스 이미지로 로드
        const instance = { prompt: fullPrompt };
        let model = config.imageModel || 'imagen-3.0-generate-002';
        const avatarPath = STReader.getCharacterAvatarPath(character);
        if (avatarPath) {
            try {
                const avatarBase64 = fs.readFileSync(avatarPath).toString('base64');
                // 캐릭터 외모 설명 추출 (레퍼런스 강화용)
                const desc = (character.description || character.data?.description || '').substring(0, 1000);
                instance.referenceImages = [{
                    referenceType: 'REFERENCE_TYPE_SUBJECT',
                    referenceId: 1,
                    referenceImage: { bytesBase64Encoded: avatarBase64 },
                    subjectImageConfig: {
                        subjectType: 'SUBJECT_TYPE_PERSON',
                        subjectDescription: desc ? this._extractAppearanceSummary(desc) : undefined,
                    },
                }];
                // 프롬프트에 레퍼런스 강조
                instance.prompt = `Exact same person as in reference image, preserving all physical features including tattoos, piercings, and facial features. ${fullPrompt}`;
                model = 'imagen-3.0-capability-001';
                console.log(`[ImageGen] 레퍼런스 이미지 포함: ${character.avatar}`);
            } catch (e) {
                console.warn(`[ImageGen] 레퍼런스 이미지 로드 실패:`, e.message);
            }
        }

        const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:predict?key=${apiKey}`;

        const requestBody = {
            instances: [instance],
            parameters: {
                sampleCount: 1,
                aspectRatio: '3:4',
                personGeneration: 'allow_adult',
                language: 'auto',
                safetySetting: 'block_only_high',
                addWatermark: false,
                outputOptions: {
                    mimeType: 'image/jpeg',
                    compressionQuality: 100,
                },
            },
        };

        console.log(`[ImageGen] API 요청 → ${model}`);
        console.log(`[ImageGen] 최종 프롬프트: ${instance.prompt?.substring(0, 200)}...`);
        if (instance.referenceImages) {
            const cfg = instance.referenceImages[0]?.subjectImageConfig;
            console.log(`[ImageGen] 레퍼런스 subjectDescription: ${cfg?.subjectDescription || '없음'}`);
        }

        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        console.log(`[ImageGen] API 응답: ${resp.status} ${resp.statusText}`);

        if (!resp.ok) {
            const err = await resp.text();
            console.error(`[ImageGen] 에러 상세:`, err.substring(0, 500));
            throw new Error(`Imagen 오류 (${resp.status}): ${err}`);
        }

        const data = await resp.json();
        const imageBase64 = data?.predictions?.[0]?.bytesBase64Encoded;

        if (!imageBase64) {
            console.error(`[ImageGen] 응답 데이터:`, JSON.stringify(data).substring(0, 500));
            throw new Error('이미지 데이터가 응답에 없습니다');
        }

        console.log(`[ImageGen] 이미지 생성 완료 (${Math.round(imageBase64.length * 0.75 / 1024)}KB)`);
        return Buffer.from(imageBase64, 'base64');
    },
    // description에서 외모 요약 (레퍼런스 subjectDescription용)
    _extractAppearanceSummary(desc) {
        const lower = desc.toLowerCase();
        const features = [];
        // 핵심 외모 특징만 추출
        const patterns = [
            /(?:blonde|brunette|black|brown|red|white|silver|golden)\s*hair/gi,
            /(?:blue|brown|green|hazel|golden|amber)\s*eyes?/gi,
            /(?:undercut|ponytail|long hair|short hair|curly|wavy|tousled)/gi,
            /(?:muscular|athletic|tall|broad.?shoulder|buff|lean)/gi,
            /(?:tattoo\w*|sleeve tattoo\w*|arm tattoo\w*|full.?body tattoo\w*)/gi,
            /(?:scar\w*|piercing\w*|earring\w*|stubble|beard)/gi,
        ];
        for (const p of patterns) {
            const m = lower.match(p);
            if (m) m.forEach(x => features.push(x.trim()));
        }
        return features.length > 0 ? features.join(', ') : undefined;
    },

    // description/personality에서 외모+성격 키워드 추출
    _buildCharacterPrefix(character) {
        const desc = (character.description || character.data?.description || '').substring(0, 3000);
        const personality = character.personality || character.data?.personality || '';
        if (!desc && !personality) return '';

        const parts = [];

        // 외모 키워드 추출
        const appearancePatterns = [
            // 체형
            /muscular|athletic|slim|tall|short|buff|lean|stocky|burly|broad.?shoulder/gi,
            // 머리
            /blonde|brunette|black hair|brown hair|red hair|white hair|silver hair|undercut|ponytail|long hair|short hair|curly|wavy|tousled/gi,
            // 눈
            /blue eyes?|brown eyes?|green eyes?|hazel eyes?|golden eyes?|amber eyes?/gi,
            // 특징
            /tattoo|scar|piercing|earring|freckle|beard|stubble|glasses/gi,
        ];

        const found = new Set();
        for (const pattern of appearancePatterns) {
            const matches = desc.match(pattern) || [];
            matches.forEach(m => found.add(m.toLowerCase()));
        }
        if (found.size > 0) parts.push([...found].join(', '));

        // 성격/분위기 키워드 추출
        const vibePatterns = /cocky|smug|confident|lazy|cold|stoic|cheerful|playful|arrogant|sly|brooding|intense|gentle|fierce|charismatic|intimidating|능글|도도|건방|무뚝뚝|차가운|다정|장난/gi;
        const vibes = new Set();
        const vibeMatches = (desc + ' ' + personality).match(vibePatterns) || [];
        vibeMatches.forEach(m => vibes.add(m.toLowerCase()));
        if (vibes.size > 0) parts.push(`${[...vibes].join(', ')} expression`);

        return parts.join(', ');
    },
};

export default ImageGen;
