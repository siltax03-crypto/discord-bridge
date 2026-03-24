import fs from 'fs';
import STReader from './st-reader.js';

let apiKey = null;

const ImageGen = {
    init(cfg) {
        // ConnectionManager 프로필에서 API 키 재사용
        const profile = STReader.getConnectionProfile(cfg.connectionProfile);
        apiKey = profile.apiKey;
    },

    /**
     * Gemini 네이티브 이미지 생성 (레퍼런스 이미지 포함)
     * 나노바나나와 동일한 방식 — Gemini generateContent + responseModalities: IMAGE
     */
    async generate(scenePrompt, character) {
        if (!apiKey) throw new Error('API 키가 없습니다');

        const model = 'gemini-3.1-flash-image-preview';
        const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent?key=${apiKey}`;

        // 메시지 parts 조립
        const parts = [];

        // 캐릭터 PNG를 레퍼런스로 포함
        const avatarPath = STReader.getCharacterAvatarPath(character);
        if (avatarPath) {
            try {
                const avatarBase64 = fs.readFileSync(avatarPath).toString('base64');
                parts.push({
                    inlineData: {
                        mimeType: 'image/png',
                        data: avatarBase64,
                    },
                });
                console.log(`[ImageGen] 레퍼런스 이미지 포함: ${character.avatar}`);
            } catch (e) {
                console.warn(`[ImageGen] 레퍼런스 이미지 로드 실패:`, e.message);
            }
        }

        // 프롬프트
        const prompt = avatarPath
            ? `Generate a new photorealistic image of the exact same person shown in the reference image above. Preserve their face, body type, tattoos, piercings, and all physical features exactly. ${scenePrompt}`
            : scenePrompt;
        parts.push({ text: prompt });

        console.log(`[ImageGen] 모델: ${model}`);
        console.log(`[ImageGen] 프롬프트: ${prompt.substring(0, 150)}...`);

        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: {
                    responseModalities: ['IMAGE'],
                    temperature: 1,
                    topP: 0.95,
                    topK: 40,
                },
            }),
        });

        console.log(`[ImageGen] API 응답: ${resp.status} ${resp.statusText}`);

        if (!resp.ok) {
            const err = await resp.text();
            console.error(`[ImageGen] 에러:`, err.substring(0, 500));
            throw new Error(`이미지 생성 오류 (${resp.status}): ${err}`);
        }

        const data = await resp.json();
        // Gemini 응답에서 이미지 파트 찾기
        const candidate = data.candidates?.[0]?.content?.parts;
        if (candidate) {
            for (const part of candidate) {
                if (part.inlineData?.data) {
                    const size = Math.round(part.inlineData.data.length * 0.75 / 1024);
                    console.log(`[ImageGen] 이미지 생성 완료 (${size}KB, ${part.inlineData.mimeType})`);
                    return Buffer.from(part.inlineData.data, 'base64');
                }
            }
        }

        console.error(`[ImageGen] 응답에 이미지 없음:`, JSON.stringify(data).substring(0, 500));
        throw new Error('이미지 데이터가 응답에 없습니다');
    },
};

export default ImageGen;
