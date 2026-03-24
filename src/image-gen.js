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
     * @param {string} scenePrompt - 장면 설명 (영어)
     * @param {object} character - ST 캐릭터 데이터
     * @returns {Buffer|null} 이미지 버퍼
     */
    async generate(scenePrompt, character) {
        console.log(`[ImageGen] 프롬프트: ${scenePrompt.substring(0, 100)}...`);

        if (!apiKey) throw new Error('Imagen API 키가 없습니다');

        const model = config.imageModel || 'imagen-3.0-generate-002';
        const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:predict?key=${apiKey}`;

        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                instances: [{ prompt: scenePrompt }],
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
            }),
        });

        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`Imagen 오류 (${resp.status}): ${err}`);
        }

        const data = await resp.json();
        const imageBase64 = data?.predictions?.[0]?.bytesBase64Encoded;

        if (!imageBase64) {
            throw new Error('이미지 데이터가 응답에 없습니다');
        }

        console.log(`[ImageGen] 이미지 생성 완료`);
        return Buffer.from(imageBase64, 'base64');
    },
};

export default ImageGen;
