# discord-bridge

SillyTavern(ST) 캐릭터를 **디스코드에서 평범한 채팅처럼** 대화하게 해주는 다리 봇.

ST 확장이 아니라 **독립 Node.js 프로세스**다. ST 서버와 같은 머신에서 돌면서, ST의
데이터 폴더를 디스크에서 직접 읽어 캐릭터/API 설정/로어북/페르소나/메모리를 가져온다.
ST의 HTTP API로는 통신하지 않는다.

---

## 동작 구조

```
Discord 채널  ──메시지──▶  discord-bridge (이 봇)
                              │  ① ST 파일 직접 읽기 (stPath)
                              │     secrets.json   → API 키
                              │     settings.json  → 커넥션 프로필 / 페르소나
                              │     characters/*.png → 캐릭터 카드(tEXt 청크)
                              │     worlds/*.json    → 로어북 / 월드인포
                              │     user/files/      → CHARM 메모리
                              │  ② AI API 직접 호출 (Gemini / Claude / OpenAI)
                              ▼
Discord 채널  ◀──웹훅────  캐릭터 이름+아바타로 응답 (+ 이미지 생성)
```

- RP(나레이션/*행동*)를 끄고 **디스코드 채팅처럼 짧게** 응답하도록 시스템 프롬프트가 강제된다.
- 채널마다 다른 캐릭터를 매핑한다. 채널 = 1:1 대화방.
- 응답은 **웹훅**으로 보내서 캐릭터 이름과 아바타가 그대로 표시된다.
- 사진을 보내면 비전(이미지 입력)으로 처리하고, AI가 `[SEND_PHOTO: ...]` 태그를 붙이면
  Gemini 네이티브 이미지 생성으로 셀카를 만들어 첨부한다.

> **전제: ST와 봇이 같은 서버(같은 파일시스템)에 있어야 한다.** 봇이 `stPath` 경로의
> 파일을 직접 읽기 때문. (오라클 클라우드 인스턴스에서 ST와 함께 구동)

---

## 설치 & 실행

```bash
cd discord-bridge
npm install
node src/index.js     # 또는 npm start
```

24시간 구동하려면 pm2 권장:

```bash
npm install -g pm2
pm2 start src/index.js --name discord-bridge
pm2 save
pm2 startup           # 부팅 시 자동 시작
pm2 logs discord-bridge
```

---

## 설정 (`config.json`)

```jsonc
{
  "stPath": "/home/ubuntu/SillyTavern",   // ST 설치 경로 (필수)
  "discordToken": "디스코드_봇_토큰",       // Discord 개발자 포털 (필수)
  "connectionProfile": "! 메인",           // ST 커넥션 프로필 이름 (아래 주의 참고)
  "maxHistoryMessages": 50,               // AI에 넣을 최근 메시지 수
  "maxResponseTokens": 1000,              // 응답 최대 토큰
  "language": "ko",                       // "ko" | "en"
  "channels": {
    "디스코드_채널ID_1": { "character": "Snow" },
    "디스코드_채널ID_2": { "character": "Blaise" }
  }
}
```

### 어디서 설정하나 — ST vs config.json

| 설정 | 어디서 | 비고 |
|---|---|---|
| AI API / 모델 / API 키 | **ST에서** | ST 커넥션 프로필 + `secrets.json`. 봇이 라이브로 읽음 |
| 캐릭터 정의 | **ST에서** | 캐릭터 카드(description/personality/scenario/system_prompt/mes_example) |
| 유저 페르소나 | **ST에서** | persona_description |
| 로어북 / 월드인포 | **ST에서** | 캐릭터 내장 북 + 연결된 월드 |
| CHARM 메모리 | **CHARM에서** | `charm-memory-*.json` 자동 주입 |
| Discord 봇 토큰 | config.json | ST에 UI 없음 |
| 채널 ↔ 캐릭터 매핑 | config.json | 수동 |
| ST 경로 / 히스토리·토큰 한도 / 언어 | config.json | 수동 |

→ **AI 백엔드·캐릭터·로어북·페르소나·메모리는 ST에서 평소대로 세팅하면 봇이 그대로 읽으므로
중복 설정할 필요 없다.** 봇 고유 설정만 config.json에서 직접 편집한다.

### ⚠️ 주의 (코드와 config 불일치)

1. **`connectionProfileId`는 무시된다.** 코드는 `connectionProfile`(Id 없는 키)를 읽는다.
   특정 프로필을 고정하려면 반드시 `"connectionProfile": "<프로필 이름>"`을 **이름으로** 넣어야 한다.
   안 넣으면 ST에서 현재 선택된 프로필(`selectedProfile`) 또는 첫 번째 프로필로 폴백한다.
2. **`stApiUrl`은 더 이상 쓰이지 않는다.** 과거 이미지 생성을 ST 프록시로 돌리던 흔적.
   지금은 Gemini를 직접 호출하므로 무시해도 된다.

---

## ST에서 준비할 것

1. **커넥션 프로필**: ConnectionManager에서 API/모델/키가 묶인 프로필을 만들어 둔다.
   - `secret-id`로 `secrets.json`의 `api_key_*` 배열에서 키를 매칭해 가져온다.
   - 지원 백엔드: Gemini(Vertex AI Express 엔드포인트), Claude, OpenAI — 프로필의 `api`/`model`로 자동 분기.
2. **캐릭터**: `config.json`의 `channels`에 적은 이름과 **카드의 name이 일치**해야 한다(대소문자 무시).
   PNG 카드(tEXt `chara` 청크) 우선, 없으면 JSON 폴백.
3. **페르소나 / 로어북 / 월드인포**: ST에서 설정해 두면 시스템 프롬프트에 자동 포함된다.

---

## Discord 쪽 준비

1. [Discord 개발자 포털](https://discord.com/developers/applications)에서 봇 생성 → 토큰 발급.
2. **Privileged Gateway Intents**에서 **Message Content Intent**를 켜야 한다 (메시지 본문을 읽어야 하므로).
3. 봇을 서버에 초대할 때 권한: 메시지 읽기/보내기, **웹훅 관리(Manage Webhooks)**, 타이핑 표시.
   - 봇이 채널마다 `bridge-<캐릭터명>` 웹훅을 자동 생성한다(캐릭터 아바타 포함).
4. 채널 ID를 복사해 `config.json`의 `channels`에 매핑한다. (개발자 모드 켜고 채널 우클릭 → ID 복사)

> 웹훅 아바타는 **공개 URL 또는 로컬 파일 경로**만 가능. base64/localhost URL은 안 된다.
> 봇은 ST 캐릭터 PNG 파일 경로를 웹훅 생성 시 아바타로 넘긴다.

---

## 동작 디테일

- **대화 기록**: `data/history/<채널ID>.json`에 자체 저장. `maxHistoryMessages` 초과분은 잘라낸다.
- **메시지 삭제 동기화**: 디스코드에서 메시지를 지우면 히스토리의 마지막 유저 메시지를 제거한다.
- **이미지 입력**: 첨부 이미지를 base64로 받아 비전 메시지로 변환해 전달.
- **이미지 생성**: `[SEND_PHOTO: 영문 묘사]` 태그 → `gemini-3.1-flash-image-preview`로 생성.
  캐릭터 PNG를 레퍼런스로 넣어 외모를 유지한다.
- **에러 처리**: 429/쿼터 초과 등은 디스코드에 임시 메시지로 알리고 10초 뒤 자동 삭제.
- **캐릭터 캐시**: 채널별 캐릭터 데이터는 5분간 캐시 후 갱신.

---

## 파일 구조

| 파일 | 역할 |
|---|---|
| `src/index.js` | 진입점. config 로드, 모듈 초기화, 봇 시작 |
| `src/bot.js` | 디스코드 이벤트 처리, 웹훅 전송, 이미지 첨부 |
| `src/st-reader.js` | ST 파일(secrets/settings/캐릭터/월드/CHARM) 읽기 |
| `src/context-builder.js` | 캐릭터+로어북+페르소나+메모리 → 시스템 프롬프트 조립 |
| `src/ai-client.js` | Gemini/Claude/OpenAI API 호출 분기 |
| `src/chat-history.js` | 채널별 대화 기록 저장/로드 |
| `src/image-gen.js` | Gemini 네이티브 이미지 생성 |

---

## 트러블슈팅

- **`config.json에 ...를 설정해주세요`**: stPath/discordToken/channels 미설정. 토큰에 `여기에`가 남아있으면 거부됨.
- **`secrets.json을 찾을 수 없습니다`**: `stPath`가 틀렸거나 ST 데이터 폴더 구조가 다름.
- **`캐릭터를 찾을 수 없습니다`**: `channels`의 character 이름이 카드 name과 불일치.
- **봇이 응답 안 함**: Message Content Intent 미설정, 또는 채널 ID 오타.
- **응답이 RP/나레이션처럼 나옴**: 시스템 프롬프트로 막지만 모델이 셀수 있음 — 프로필 모델 확인.
- **이미지 생성 실패**: 프로필 API 키가 이미지 모델 권한이 있는지 확인.
