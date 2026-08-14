# DBus Collector 단일 브랜치 제품 모듈 설계

## 1. 상태

- 상태: 승인됨
- 승인일: 2026-08-12
- 승인 근거: 사용자가 공통·generic·LS를 한 브랜치와 한 version으로 관리하고,
  같은 `neo-pkg-dbus`를 target별로 선택 빌드하는 구조를 승인했다.

## 2. 문제

generic과 LS를 별도 브랜치로 유지하면 공통 수정도 두 번 적용해야 한다. 반대로 한
파일 안에 업체 이름을 검사하는 조건문을 계속 추가하면 제품 차이가 공통 코드 전체로
퍼진다. 실제 배포에서는 generic과 LS를 동시에 설치하지 않고 둘 중 하나를 선택한다.

## 3. 목표와 제외 범위

### 목표

- 하나의 개발 브랜치, package 이름 `neo-pkg-dbus`, 공통 version을 사용한다.
- 기존 `frontend/`, `cgi-bin/src/`, `scripts/`를 공통 원본 위치로 유지한다.
- 실제로 다른 Frontend·Backend 동작과 자산만 `products/`로 분리한다.
- 빌드는 원본 source를 수정하지 않고 저장소 루트를 선택 target의 완성 package로 만든다.
- 인자 없는 기본 build와 Git에 저장하는 완성 산출물은 항상 generic이다.
- 공통 코드가 `provider.id === "ls"`처럼 업체 이름으로 분기하지 않게 한다.

### 제외 범위

- 임의 Provider 자동 발견 플러그인 시스템
- npm workspace 또는 여러 저장소 분리
- 제품별 package 이름과 version
- `dist/`에 target별 완성 package를 동시에 보관하는 구조
- `product.json`, 제품별 build script와 자동 경로 등록
- 기존 사용자 Job·Settings schema 변경

## 4. 소스와 생성 영역

```text
neo-pkg-dbus/
├─ package.json                 이름 neo-pkg-dbus, 공통 version과 build 명령
├─ index.html                   선택 target의 생성 Frontend
├─ main.html                    선택 target의 생성 Frontend
├─ side.html                    선택 target의 생성 Frontend
├─ frontend/                    공통 Frontend 원본
├─ cgi-bin/
│  ├─ src/                      공통 Backend 원본
│  ├─ product/                  선택 target의 생성 Backend
│  ├─ provider.json             선택 Provider의 생성 Profile
│  ├─ interfaces.d/             선택 Provider의 생성 Interface
│  └─ conf.d/                   사용자 설정, build 수정 금지
├─ scripts/                     공통 package lifecycle와 build
├─ docs/                        공통·Provider 계약
└─ products/
   ├─ generic/
   │  ├─ frontend/index.jsx     generic 전용 화면 동작
   │  └─ backend/index.js       generic 전용 Job 정책
   └─ ls/
      ├─ frontend/index.jsx     LS 고정 Job 화면
      ├─ backend/index.js       LS 검증·Tag 생성 정책
      ├─ provider.json          LS 읽기 전용 실행 정책
      └─ interfaces/
         └─ ls-plc-device.json
```

공통 폴더를 새로 만들어 기존 소스를 대량 이동하지 않는다. `products/`에는 제품별
차이만 둔다. 지원 target은 공통 build script에 `generic`, `ls` 두 값으로 명시한다.

루트의 HTML과 `cgi-bin/product`, `cgi-bin/provider.json`,
`cgi-bin/interfaces.d`는 생성 영역이다. `frontend/src`, `cgi-bin/src`, `products`,
`scripts`, `docs`, `cgi-bin/conf.d`는 원본 또는 사용자 데이터이므로 build가 바꾸지
않는다.

## 5. 제품 모듈 경계

Frontend 제품 모듈은 다음 책임만 가진다.

- 제품별 Job Method 영역 렌더링
- 새 Job의 Method Call 초깃값 생성
- DBus Interface 관리 진입점 표시 여부

Backend 제품 모듈은 다음 책임만 가진다.

- 공통 Job 검증 뒤 실행할 제품 추가 검증
- 제품 입력 변경에 따른 Tag 재계산
- 제품 고정 규칙의 정규화

공통 Frontend와 Backend는 build가 고른 모듈을 호출하며 업체 ID를 비교하지 않는다.
DBus 호출, Database 설정·저장, Job lifecycle, Controller, DataViewer, Side/Main 통신과
디자인 시스템은 공통 책임이다. 범용 플러그인 API는 만들지 않고 두 제품에 실제로
필요한 고정 hook만 둔다.

## 6. Provider Profile 경계

`provider.json`은 package 이름이나 source 위치를 알려 주는 manifest가 아니다.
실행 중 Frontend와 Backend가 함께 사용하는 읽기 전용 제품 정책이다.

- generic target에는 생성 `cgi-bin/provider.json`이 없고
  `GET /settings.data.provider`는 `null`이다.
- LS target은 `products/ls/provider.json`을 생성 `cgi-bin/provider.json`으로 복사한다.
- 실제 LS Tag 생성 코드는 `products/ls/backend/`에 둔다.
- 제품 경로는 규칙으로 고정하므로 `product.json`을 만들지 않는다.

## 7. 빌드 계약

```bash
npm run build
npm run build -- --target=generic
npm run build -- --target=ls
```

인자 없는 `npm run build`는 항상 `generic`이며 명시적인 `--target=generic`과 같은
결과다. 지원하지 않는 target, 필수 제품 모듈 누락, 잘못된 Profile 또는 Interface는
build 실패다. 잘못된 LS를 generic으로 대신 만들지 않는다. 같은 루트를 교체하므로
`build:all`은 제공하지 않는다. 두 target 회귀 검증은 임시 디렉터리에서 각각
빌드하는 test 명령으로 수행할 수 있다.

build는 임시 staging에서 완성본을 검증한 뒤 생성 영역만 교체한다.

1. 선택 Frontend 제품 모듈을 연결해 HTML 세 개를 만든다.
2. `cgi-bin/product/`를 비우고 선택 Backend 제품 모듈만 만든다.
3. 생성 Profile과 Interface 영역을 먼저 비운다.
4. 필요한 target만 Profile과 Interface asset을 복사한다.
5. 루트와 CGI manifest의 이름·version·최소 Neo version을 검증한다.
6. 모든 검증 뒤 생성 영역을 교체한다. 실패하면 직전 완성 package를 반쯤 바꾸지 않는다.

## 8. 이름과 version

루트 `package.json`의 `name: "neo-pkg-dbus"`와 `version`이 모든 target의 유일한
이름·version 기준이다.

| target | package 이름 | 동작 |
|---|---|---|
| `generic` | `neo-pkg-dbus` | 자유 Interface·Method 제품 |
| `ls` | `neo-pkg-dbus` | LS 고정 Method 제품 |

target은 다른 package를 뜻하지 않고 build 시 선택하는 동작 구성이다. 두 target은
같은 설치 위치를 사용하며 동시에 설치하지 않는다.

## 9. Git 완성 산출물

저장소에는 설치 즉시 사용할 수 있는 기본 generic 완성 package를 함께 둔다.

- 모든 커밋 직전에 저장소 루트에서 인자 없는 `npm run build`를 성공시킨다.
- LS 또는 다른 업체를 빌드했어도 커밋 전 기본 build로 generic을 복원한다.
- 업체 전용 Profile, Interface, Backend·Frontend **생성 산출물**은 커밋하지 않는다.
- 업체 전용 **원본 source**는 `products/<target>/`에 커밋한다.
- 빌드 실패, 루트 build 명령 부재, generic 산출물 검증 실패 시 커밋하지 않는다.

## 10. 계약 문서 경계

- `DBUS_SDD.md`, `FE_DESIGN.md`, `BE_DESIGN.md`는 공통 계약이다.
- `providers/DBUS_PROVIDER_PROFILE.md`는 Provider Profile 공통 계약이다.
- `providers/DBUS_LS_PROFILE.md`는 LS 차이만 정의하고 그 부분만 공통 계약보다 우선한다.
- generic은 기본 동작이므로 중복 계약서를 만들지 않는다.

## 11. 브랜치 통합 순서

1. 공통 코드를 통합 브랜치 기준으로 삼는다.
2. generic에서만 필요한 화면·정책을 `products/generic`으로 분리한다.
3. LS 브랜치 변경을 공통 변경과 LS 전용 변경으로 분류한다.
4. 공통 변경은 한 번만 반영하고 LS 전용 변경만 `products/ls`로 옮긴다.
5. target별 검증을 통과한 뒤 기존 제품 브랜치는 보관 상태로 전환한다.

기존 브랜치를 통째로 덮어쓰지 않는다. 공통 수정이 LS 모듈 안에 중복되지 않았는지
기능 단위로 검토한다.

## 12. 검증과 완료 기준

- 공통 단위 테스트를 한 번 실행한다.
- generic은 자유 Interface·Method·Output Mapping을 확인한다.
- LS는 고정 `GetDeviceData`, `/data` 숫자 배열, LS Tag 재계산을 확인한다.
- 두 target의 이름 `neo-pkg-dbus`, 공통 version, Profile, Interface를 검사한다.
- generic 결과에 LS Profile·Interface·Tag 생성 산출물이 없는지 검사한다.
- target 전환 전후에 원본 source와 사용자 설정이 바뀌지 않는지 검사한다.
- LS 검증 뒤 기본 build를 실행하면 LS 생성 asset이 모두 사라지는지 검사한다.
- Git staged/commit 대상의 완성 산출물이 generic인지 검사한다.
- 두 target을 각각 Neo에 배치해 같은 package 경로의 CGI, Job과 DataViewer를 확인한다.

## 13. 미확인 위험

- 두 기존 브랜치의 차이를 아직 전체 기능 단위로 분류하지 않았다.
- 실제 Neo JSH에서 생성 Backend의 고정 product module 경로를 검증해야 한다.
- 생성 영역의 안전한 교체와 원격 배포 연결은 구현 계획에서 확인해야 한다.
