# Discord Bridge — ST 설정 UI (확장 + 서버 플러그인)

config.json을 손으로 편집하는 대신 **SillyTavern 설정 패널에서** discord-bridge를 설정한다.

- `st-extension/` — ST 확장 (브라우저 UI)
- `st-plugin/` — ST 서버 플러그인 (config.json 파일 I/O + 프로필/캐릭터/채널 목록 제공)

브라우저는 서버 파일을 직접 쓸 수 없으므로 **둘 다** 설치해야 동작한다.

---

## 1. 서버 플러그인 설치 (`st-plugin/`)

ST의 `plugins/` 폴더에 넣는다. ST 루트가 `/home/ubuntu/SillyTavern`이라면:

```bash
mkdir -p /home/ubuntu/SillyTavern/plugins/discord-bridge-config
cp /home/ubuntu/discord-bridge/st-plugin/index.js \
   /home/ubuntu/SillyTavern/plugins/discord-bridge-config/
# 또는 심볼릭 링크 (소스 갱신 자동 반영)
# ln -s /home/ubuntu/discord-bridge/st-plugin /home/ubuntu/SillyTavern/plugins/discord-bridge-config
```

### 서버 플러그인 활성화

ST의 `config.yaml`에서 플러그인을 켠다:

```yaml
enableServerPlugins: true
```

### discord-bridge 경로 지정

플러그인은 기본적으로 `/home/ubuntu/discord-bridge/config.json`을 읽고 쓴다.
경로가 다르면 ST를 실행할 때 환경변수로 알려준다:

```bash
DISCORD_BRIDGE_PATH=/path/to/discord-bridge node server.js
# pm2라면: pm2 set 또는 ecosystem 파일의 env에 추가
```

ST를 재시작하면 콘솔에 `[discord-bridge-config] 플러그인 로드됨` 이 떠야 한다.
마운트 경로: `/api/plugins/discord-bridge-config`

---

## 2. 확장 설치 (`st-extension/`)

third-party 확장 폴더에 넣는다:

```bash
mkdir -p /home/ubuntu/SillyTavern/data/default-user/extensions/discord-bridge
cp /home/ubuntu/discord-bridge/st-extension/* \
   /home/ubuntu/SillyTavern/data/default-user/extensions/discord-bridge/
```

> ST 버전에 따라 third-party 경로가 `public/scripts/extensions/third-party/`일 수도 있다.
> ST의 **Extensions → Install Extension**으로 깃 URL을 넣어 설치해도 된다.

브라우저 새로고침 → **Extensions 패널**에 **🤖 Discord Bridge** 드로어가 생긴다.

---

## 3. 봇 heartbeat (상태 표시용)

`src/index.js`에 봇이 30초마다 `data/bot-status.json`을 쓰는 heartbeat가 추가돼 있다.
확장의 상태 표시(🟢/🔴)가 이 파일을 읽는다. **봇을 한 번 재시작**해야 heartbeat가 시작된다:

```bash
pm2 restart discord-bridge
```

---

## 사용 흐름

1. ST 설정 패널 → 🤖 Discord Bridge 열기
2. 봇 토큰 입력 → **저장** (저장하면 플러그인이 디스코드 API로 채널 목록을 가져옴)
3. 커넥션 프로필 선택 (ST 프로필 드롭다운), 언어/한도 설정
4. **채널 ↔ 캐릭터 매핑**: [+ 추가] → 채널 드롭다운(봇이 들어간 채널) + 캐릭터 드롭다운(ST 카드)
5. **저장** → config.json 기록됨
6. **봇 재시작**: `pm2 restart discord-bridge` (config.json은 봇 시작 시 읽으므로 재시작 필요)

> 재시작 버튼은 ST UI에 넣지 않았다(상태 표시만). 저장 후 SSH/pm2로 직접 재시작한다.

---

## 보안 메모

- 토큰은 플러그인이 확장에 보낼 때 `__SAVED__`로 마스킹한다. 저장 시 입력칸이 비어 있으면 기존 토큰을 유지한다.
- 플러그인 엔드포인트는 ST 인증(getRequestHeaders / CSRF) 뒤에 있다. ST를 외부에 열어뒀다면 ST 자체 인증을 반드시 켤 것.

---

## 착수 시 정리한 config↔코드 정합성

- 확장은 `connectionProfile`(이름) 키로 저장한다. 기존 `connectionProfileId`(죽은 키)는 읽기 시 폴백으로만 참고.
- `stApiUrl`은 UI에서 다루지 않는다(미사용).
