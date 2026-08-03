# neo-pkg-dbus

Machbase Neo용 작업별 서비스 패키지입니다. 생성만으로는 카운터 예제가
실행되지 않습니다. 패키지의 install/start 뒤 Neo Controller가 오래 실행되는
worker/service를 시작하면 카운터를 1씩 올리고, CGI API와 화면은 그 결과를 읽어
보여 줍니다.

이 프로젝트는 패키지 개발을 시작하기 위한 예제입니다. 운영 환경에 필요한 동시성, 고가용성, 장애 복구, 보안 정책은 실제 패키지의 목적에 맞게 구현하세요.

## 화면 profile

Side Job 목록과 Main의 선택 Job 상세를 보여 줍니다. Job 행은 28px이고, Job 스위치는 클릭 영역 28×28px 안에 28×13px 트랙과 9px 손잡이를 둡니다.
`jobs` 설정을 바꿀 때는 먼저 Job을 중지한 뒤 Main의 `Edit`을 사용합니다.
`side=yes`에서는 시작·중지를 Side 스위치가 맡으므로 Main에는 `Edit`과 `Delete`만
표시합니다. 실행 중인 Job은 설정 변경과 삭제를 할 수 없습니다.

Job을 고른 값은 React 화면이 잠깐 기억하는 선택일 뿐입니다. 다음에 어떤 Job을 만들지 정하는 기준은 `cgi-bin/conf.d/jobs/`, 실제 실행 여부의 기준은 Neo Controller, 카운터 결과의 기준은 `cgi-bin/data/`입니다. 화면을 새로 열거나 새로고침하면 API가 이 기준 값을 다시 읽어 표시합니다.

기본 화면은 기존 Neo 패키지와 같은 UI 규칙을 사용합니다. Side는 256px이고,
일반 문구는 영어, 기술 값과 결과 JSON은 고정폭 글꼴로 표시합니다. Pretendard와
D2Coding은 jsDelivr에서, Material Symbols는 Google Fonts에서 불러옵니다. 따라서
정확한 글꼴과 아이콘을 처음 표시할 때는 인터넷 연결이 필요합니다. CDN을 사용할 수
없으면 문자는 시스템의 `sans-serif`와 `monospace`로 대체됩니다.

## 로컬 프런트 빌드

아래 명령은 패키지를 만든 뒤 개발자가 필요할 때 직접 실행합니다. neo-pkg 초기화는
파일과 profile별 기본 구조를 만들고 manifest만 확인하며, `npm install`, 테스트,
빌드를 자동으로 실행하지 않습니다.

```bash
cd frontend
npm ci
npm run build:root
```

빌드가 끝나면 루트에 `index.html`, `main.html`, `side.html`이 만들어집니다. 각 파일은 JS와 CSS를 안에 포함한 단일 HTML입니다.

## 로컬 프런트 개발

Machbase Neo를 `http://localhost:5654`에서 먼저 실행합니다.

그다음 프런트 개발 서버를 실행합니다.

```bash
cd frontend
npm ci
npm run dev
```

브라우저에서 `http://localhost:5173`을 엽니다. Vite 개발 서버는 `/public/neo-pkg-dbus`, `/api`, `/web` 요청을 `http://localhost:5654`의 Neo 서버로 전달합니다. `/web`의 WebSocket 연결도 같은 주소로 전달합니다.

`npm run dev`는 frontend 개발 서버만 실행합니다. Neo 서버는 HTTP 요청마다 CGI를
실행하고, Neo Controller는 오래 실행할 worker/service를 관리합니다. 패키지
service의 등록·시작은 package lifecycle 또는 CGI 제어 API가 Controller에 요청합니다.
브라우저 화면은 API에서 받아 온 값을 표시할 뿐이며, browser/localStorage를
카운터·서비스 상태의 진짜 저장소로 쓰지 않습니다.

## CGI와 서비스 확인

작업 API는 목록, 등록, 시작, 중지, 삭제를 제공합니다. 등록하면 서비스가 바로 실행되고 Neo Controller 재시작 때도 다시 실행됩니다. 등록은 `{"name":"example","config":{}}`를 받고 나머지 작업은 `?name=example`을 사용합니다. 설정은 `cgi-bin/conf.d/jobs/`에 저장됩니다.

CGI와 서비스의 실제 실행 환경은 Machbase Neo JSH입니다. 루트 `package.json`의
script는 Neo의 JSH shell에서 `pkg run <script>`로 실행합니다. Node에서는 JSH
의존성을 격리한 생명주기, CGI 경계, CounterStore 단위 테스트만 실행합니다.

CGI는 HTTP 요청 하나를 처리하고 JSON을 돌려준 뒤 끝납니다. 반대로 worker/service는
Neo Controller가 시작한 뒤 오래 실행되며 카운터 값을 계속 올립니다. 즉, “API를
부른 것”과 “계속 일하는 서비스”는 다른 역할입니다.

## 예제에서 값이 흐르는 길

1. React 화면이 `/public/neo-pkg-dbus/cgi-bin/api/...`로 상태·시작·중지 요청을 보냅니다.
2. Neo 서버가 HTTP 요청마다 해당 CGI를 실행합니다. CGI는 manager를 한 번 호출하고
   JSON으로 답한 뒤 끝납니다.
3. `JobManager`가 `cgi-bin/conf.d/jobs/`에서 작업 이름과 `intervalMs` 설정을 읽고, 작업마다 Neo 서비스의 등록·시작·중지를 Controller에 요청합니다.
4. Controller가 시작한 작업별 `worker.js`가 오래 실행하며 `cgi-bin/data/jobs/<job-name>.counter.json` 카운터 결과를 갱신합니다.
5. 화면은 API를 다시 불러 Controller 상태와 카운터 결과를 React 표시 상태로 보여 줍니다.

| 위치 | 무엇을 뜻하나요? |
|---|---|
| `cgi-bin/conf.d/jobs/` | jobs에서 만들 작업의 이름과 실행 간격 설정 |
| Neo Controller | 작업마다 서비스가 등록·실행·중지되었는지, PID와 종료 코드를 알려 줍니다. |
| `cgi-bin/data/jobs/<job-name>.counter.json` | 작업별 `worker.js`가 만든 카운터 결과 (`count`, 시작·갱신 시각) |
| React 표시 상태 | 화면의 로딩·오류·버튼 대기와 API에서 방금 받은 사본 |

설정 파일이 있어도 지금 서비스가 실행 중이라는 뜻은 아니므로, 실행 상태는 항상 Neo Controller API로 확인합니다.

## `jobs`와 `single` 중 고르기

- `jobs`: 여러 일을 따로 만들고 각각 시작·중지·삭제해야 할 때 고릅니다. 작업마다
  Neo 서비스 하나와 설정 파일 하나가 생깁니다.
- `single`: 패키지 전체가 하나의 일을 오래 할 때 고릅니다. 패키지 이름의 Neo 서비스
  하나만 관리합니다.

```bash
node cgi-bin/tests/http.test.cjs
node cgi-bin/tests/controller-state.test.cjs
node cgi-bin/tests/job-manager.test.cjs
node cgi-bin/tests/counter-store.test.cjs
```

예제 결과는 `cgi-bin/data/`에 저장됩니다. 실행 상태는 Neo Controller에서, 로그는
현재 Neo 서비스 환경에서 확인합니다.

## 버전과 GitHub Release

1. 루트 `package.json`과 `cgi-bin/package.json`의 `version`을 같은 SemVer로 올립니다.
2. 프런트 빌드, CGI HTTP 테스트, 서비스 단위 테스트와 실제 JSH 동작을 다시 확인합니다.
3. 기존 저장소의 태그 관례를 따릅니다. package 버전 `1.1.0`에는 `1.1.0` 또는 `v1.1.0`을 사용할 수 있으며, 앞의 `v`를 제외한 값은 package 버전과 같아야 합니다.
4. 최신 공개 Release를 만든 뒤 tag 시점의 루트 `package.json`에 올바른 `version`과 `minServerVersion`이 있는지 확인합니다.
5. Release가 공개된 뒤 Hub가 읽을 수 있는지 확인합니다. 별도로 첨부한 Release artifact는 필수 조건으로 가정하지 않습니다.

## neo-pkg-hub 등록 예시

`neo-pkg-hub/packages.yaml`에는 저장소와 패키지 정보를 다음과 같은 형태로 등록합니다.

```yaml
packages:
  - name: neo-pkg-dbus
    organization: <owner>
    repo: neo-pkg-dbus
    docs: neo-pkg-dbus/docs/index.en.md # 선택
```

이 프로젝트는 hub 저장소를 자동으로 수정하거나 PR을 만들지 않습니다.

## 최소 서버 버전

이 패키지의 `minServerVersion`은 `8.5.6`입니다.
