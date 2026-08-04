# neo-pkg-dbus

Machbase Neo에서 Linux DBus 값을 읽어 TAG table에 저장하는 Job 패키지입니다. 기본 Profile은 LS ELECTRIC PLC의 `ls.plc`이며, Job마다 `_dbu_<jobName>` service 하나를 사용합니다.

최소 Machbase Neo 버전은 `8.5.6`입니다. 설정 schema는 `schemaVersion: 1`입니다.

## 주요 기능

- Job 생성, 검증, 설치, 시작, 정지, 수정, 삭제
- Built-in `ls-electric-plc` Profile과 Custom Profile/Method 관리
- typed DBus 입력, `raw`/`json` 응답 해석, LS 주소 기반 Tag 생성
- `bm`/`mb` Transform, `perMethod`/`afterAllMethods` 저장 정책
- 실패 backoff, 마지막 cycle 결과, Job 로그
- Job 전용 DataViewer Grid/Chart
- 256px Side와 HashRouter 기반 Main 화면

실행 중이거나 상태를 알 수 없는 Job은 수정·삭제할 수 없습니다. 먼저 Job을 안전하게 정지해야 합니다.

## 설정 위치

| 위치 | 내용 |
|---|---|
| `cgi-bin/profiles.d/` | 읽기 전용 Built-in Profile |
| `cgi-bin/conf.d/settings.json` | 전역 설정 |
| `cgi-bin/conf.d/profiles/` | Custom Profile |
| `cgi-bin/conf.d/jobs/` | Job 설정 |
| `cgi-bin/conf.d/db-servers/` | 등록 DB server 접속 정보 |
| `cgi-bin/logs/` | Job별 회전 로그 |

DB 비밀번호는 등록 DB server 파일에만 저장하며 Job 설정, API 조회, 로그에 다시 표시하지 않습니다.

## 프런트엔드 개발과 빌드

```bash
cd frontend
npm ci
npm run test:layout
npm run build:root
```

빌드는 루트의 `index.html`, `main.html`, `side.html`을 각각 JS/CSS가 포함된 단일 HTML로 만듭니다.

로컬 개발 서버는 다음과 같이 실행합니다.

```bash
cd frontend
npm run dev
```

Machbase Neo가 `http://localhost:5654`에서 실행 중이면 Vite proxy가 `/public/neo-pkg-dbus`, `/api`, `/web` 요청을 전달합니다.

## Backend 테스트

```bash
node --test cgi-bin/tests/*.test.cjs
```

Node 테스트는 JSH 모듈을 주입 가능한 대역으로 검사합니다. 실제 배포 전에는 Neo 8.5.6에서 System Bus, `ls.plc`, `machcli` TAG append, service details, shutdown 정리를 추가로 확인해야 합니다.

## API 규칙

base path는 `/public/neo-pkg-dbus/cgi-bin/api`입니다.

성공 응답:

```json
{"ok":true,"data":{}}
```

실패 응답:

```json
{"ok":false,"code":"JOB_INVALID","reason":"설명","details":{}}
```

주요 API는 `/settings`, `/profile`, `/method`, `/job`, `/job/validate`, `/job/install`, `/job/start`, `/job/stop`, `/job/last-run`, `/dbus/call`, `/db/*`, `/log/*`입니다. Job 생성은 `POST /job`에 `{ "name": "line-a", "config": { ... } }`를 보내며, 수정은 `PUT /job?name=line-a`에 이름을 뺀 부분 config를 보냅니다.

## 문서 우선순위

1. `docs/specs/DBUS_SDD.md`
2. `docs/specs/FE_DESIGN.md`, `docs/specs/BE_DESIGN.md`
3. 화면 시각 값은 루트 `DESIGN.md`

`DESIGN.md`는 색, 글꼴, 간격, 4px 모서리와 256px Side의 고정 기준입니다.

## 버전과 Release

루트 `package.json`과 `cgi-bin/package.json`의 `version`을 같은 SemVer로 유지합니다. 프런트 빌드, Backend 테스트, 실제 JSH 통합 검증 뒤 같은 버전의 Git tag와 공개 GitHub Release를 만듭니다.
