let config = {};

const ImageGen = {
    init(cfg) {
        config = cfg;
    },

    /**
     * ST 서버의 Google Imagen API를 통해 이미지 생성
     * @param {string} scenePrompt - 장면 설명 (영어)
     * @param {object} character - ST 캐릭터 데이터
     * @returns {Buffer|null} 이미지 버퍼
     */
    async generate(scenePrompt, character) {
        const fullPrompt = scenePrompt;
        console.log(`[ImageGen] 프롬프트: ${fullPrompt.substring(0, 100)}...`);

        const stApiUrl = config.stApiUrl || 'http://localhost:8000';
        const model = config.imageModel || 'imagen-3.0-generate-002';

        const resp = await fetch(`${stApiUrl}/api/google/generate-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: fullPrompt,
                model,
                api: 'vertexai',
                aspect_ratio: '3:4',
            }),
        });

        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`Imagen 오류 (${resp.status}): ${err}`);
        }

        const data = await resp.json();
        if (data.image) {
            console.log(`[ImageGen] 이미지 생성 완료`);
            return Buffer.from(data.image, 'base64');
        }

        throw new Error('이미지 데이터가 응답에 없습니다');
    },
};

export default ImageGen;
