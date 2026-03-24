import STReader from './st-reader.js';

let config = {};

const ImageGen = {
    init(cfg) {
        config = cfg;
    },

    /**
     * 이미지 생성 — ST의 SD 설정에서 소스를 읽어 해당 API 호출
     * @param {string} scenePrompt - 장면 설명 (영어)
     * @param {object} character - ST 캐릭터 데이터
     * @returns {Buffer|null} PNG 이미지 버퍼
     */
    async generate(scenePrompt, character) {
        // 캐릭터 외모 태그 추출
        const appearanceTags = this._extractAppearance(character);
        const fullPrompt = appearanceTags
            ? `${appearanceTags}, ${scenePrompt}`
            : scenePrompt;

        console.log(`[ImageGen] 프롬프트: ${fullPrompt.substring(0, 100)}...`);

        // 이미지 생성 소스 결정
        const source = config.imageSource || this._detectSource();

        switch (source) {
            case 'novelai':
                return this._generateNovelAI(fullPrompt);
            case 'nanogpt':
                return this._generateNanoGPT(fullPrompt);
            default:
                console.warn(`[ImageGen] 지원하지 않는 소스: ${source}, NovelAI로 시도`);
                return this._generateNovelAI(fullPrompt);
        }
    },

    // ST settings에서 SD 소스 감지
    _detectSource() {
        try {
            const settings = STReader.getSettings();
            // ST SD extension 설정 경로들
            const sdSource = settings.sd_source
                || settings.extension_settings?.sd?.source
                || settings.sd?.source;

            if (sdSource === 'nanogpt' || sdSource === 'NanoGPT') return 'nanogpt';
            if (sdSource === 'novel' || sdSource === 'NovelAI') return 'novelai';
            return sdSource || 'novelai';
        } catch {
            return 'novelai';
        }
    },

    // --- NovelAI 이미지 생성 ---
    async _generateNovelAI(prompt) {
        const apiKey = this._getSecretValue('api_key_novel');
        if (!apiKey) throw new Error('NovelAI API 키를 찾을 수 없습니다');

        const body = {
            input: prompt,
            model: 'nai-diffusion-3',
            action: 'generate',
            parameters: {
                width: 512,
                height: 768,
                scale: 11,
                sampler: 'k_euler',
                steps: 28,
                n_samples: 1,
                negative_prompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark',
            },
        };

        const resp = await fetch('https://image.novelai.net/ai/generate-image', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            throw new Error(`NovelAI 오류 (${resp.status}): ${await resp.text()}`);
        }

        // NovelAI는 zip 파일로 반환 — 첫 번째 이미지 추출
        const buffer = Buffer.from(await resp.arrayBuffer());
        return this._extractFromZip(buffer);
    },

    // --- NanoGPT 이미지 생성 ---
    async _generateNanoGPT(prompt) {
        // NanoGPT API — ST secrets에서 키 가져오기
        const apiKey = this._getSecretValue('api_key_nanogpt') || this._getSecretValue('api_key_makersuite');
        if (!apiKey) throw new Error('NanoGPT API 키를 찾을 수 없습니다');

        // NanoGPT 이미지 생성 엔드포인트
        const body = {
            prompt,
            model: config.imageModel || 'google/imagen-4',
            n: 1,
            size: '512x768',
        };

        const resp = await fetch('https://nano-gpt.com/api/v1/images/generations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            throw new Error(`NanoGPT 오류 (${resp.status}): ${await resp.text()}`);
        }

        const data = await resp.json();
        // OpenAI 호환 형식: { data: [{ url: '...' }] } 또는 { data: [{ b64_json: '...' }] }
        const imageData = data.data?.[0];
        if (imageData?.b64_json) {
            return Buffer.from(imageData.b64_json, 'base64');
        }
        if (imageData?.url) {
            const imgResp = await fetch(imageData.url);
            return Buffer.from(await imgResp.arrayBuffer());
        }
        throw new Error('NanoGPT 응답에서 이미지를 찾을 수 없습니다');
    },

    // NovelAI zip에서 이미지 추출 (간이 파서)
    _extractFromZip(zipBuffer) {
        // ZIP local file header: PK\x03\x04
        // 파일 데이터는 헤더 뒤에 바로 옴
        const signature = zipBuffer.readUInt32LE(0);
        if (signature !== 0x04034b50) {
            // zip이 아니면 그냥 이미지로 취급
            return zipBuffer;
        }

        const compressedSize = zipBuffer.readUInt32LE(18);
        const fileNameLength = zipBuffer.readUInt16LE(26);
        const extraLength = zipBuffer.readUInt16LE(28);
        const dataOffset = 30 + fileNameLength + extraLength;

        // NovelAI는 비압축(store) 방식 사용
        const compressionMethod = zipBuffer.readUInt16LE(8);
        if (compressionMethod === 0) {
            // Store — 비압축
            return zipBuffer.subarray(dataOffset, dataOffset + compressedSize);
        }

        // 압축된 경우 전체 버퍼 반환 (폴백)
        return zipBuffer;
    },

    /**
     * 캐릭터 설명에서 외모 태그 추출 (InstaApp.extractAppearanceTags 참고)
     */
    _extractAppearance(character) {
        const desc = (character.description || '').substring(0, 2000).toLowerCase();
        const tags = [];

        // 머리색
        const hairColors = ['blonde', 'brunette', 'black hair', 'brown hair', 'red hair',
            'pink hair', 'blue hair', 'white hair', 'silver hair', 'purple hair',
            'green hair', 'orange hair', 'gray hair', 'golden hair'];
        for (const c of hairColors) {
            if (desc.includes(c)) { tags.push(c); break; }
        }

        // 머리 스타일
        const hairStyles = ['long hair', 'short hair', 'medium hair', 'ponytail', 'twin tails',
            'braids', 'braid', 'bun', 'bob cut', 'wavy hair', 'curly hair', 'straight hair'];
        for (const s of hairStyles) {
            if (desc.includes(s)) { tags.push(s); break; }
        }

        // 눈 색
        const eyeColors = ['blue eyes', 'brown eyes', 'green eyes', 'red eyes', 'golden eyes',
            'purple eyes', 'amber eyes', 'heterochromia', 'black eyes'];
        for (const c of eyeColors) {
            if (desc.includes(c)) { tags.push(c); break; }
        }

        // 한국어 외모 키워드
        const koreanMap = {
            '금발': 'blonde hair', '흑발': 'black hair', '갈색머리': 'brown hair',
            '은발': 'silver hair', '붉은머리': 'red hair', '분홍머리': 'pink hair',
            '긴머리': 'long hair', '단발': 'short hair', '포니테일': 'ponytail',
            '트윈테일': 'twin tails', '파란눈': 'blue eyes', '갈색눈': 'brown eyes',
        };
        const descKo = (character.description || '').substring(0, 2000);
        for (const [ko, en] of Object.entries(koreanMap)) {
            if (descKo.includes(ko) && !tags.includes(en)) {
                tags.push(en);
            }
        }

        return tags.length > 0 ? `1girl, ${tags.join(', ')}` : '';
    },

    // secrets.json에서 active한 키 값 추출 (배열 구조 대응)
    _getSecretValue(secretKey) {
        try {
            const secrets = STReader.getSecrets();
            const val = secrets[secretKey];
            if (Array.isArray(val)) {
                const active = val.find(e => e.active) || val[0];
                return active?.value || null;
            }
            return typeof val === 'string' ? val : null;
        } catch {
            return null;
        }
    },
};

export default ImageGen;