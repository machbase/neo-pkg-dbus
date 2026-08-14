# LS Electric DBus Collector 사용자 매뉴얼 설계

## 목적

Linux 또는 Docker에서 Machbase Neo를 처음 실행하는 사용자가 LS Electric용
`neo-pkg-dbus` 테스트 빌드를 설치하고 첫 Job을 실행할 수 있는 Markdown 매뉴얼을
작성한다. 처음 읽는 구간은 따라 하기 중심으로 짧게 유지하고, 각 설정의 의미와
세부 규칙은 뒤쪽 참고 장에서 설명한다.

## 결과물

- 본문: `docs/LS_USER_MANUAL.md`
- 실제 화면 이미지: `docs/assets/ls-manual/`
- Google Docs로 옮기기 쉽도록 표준 Markdown 제목, 표, 목록, 코드 블록과 상대 경로
  이미지만 사용한다.
- 제품 저장소는 `https://github.com/machbase/neo-pkg-dbus`이며, 작성 시점에는
  `main` 브랜치에 LS 완성 빌드가 있다고 가정한다.

## 독자와 환경

- 대상: Linux 서버 또는 Docker를 사용하는 LS Electric 연동 테스트 사용자
- `LS`는 대한민국의 `LS ELECTRIC`을 뜻한다.
- Machbase Neo 직접 실행과 Docker 실행을 각각 제공한다.
- Neo의 실제 FileDir를 확인한 뒤 `<FileDir>/public/neo-pkg-dbus`에 패키지를
  배치하도록 안내한다. Docker 기본 예시는 `/file/public/neo-pkg-dbus`를 사용한다.

## 문서 순서

### 1. 빠른 시작

1. 개발 중인 테스트 빌드와 알려진 제한을 짧게 알린다.
2. Linux에서 최신 Neo를 내려받아 실행하는 절차를 제공한다.
3. Docker로 Neo를 실행하는 대체 절차를 제공한다.
4. `machbase/neo-pkg-dbus`를 내려받아 Neo의 `public/neo-pkg-dbus`에 배치한다.
5. Neo Web File Explorer에서 `public/neo-pkg-dbus`를 열고 `index.html`,
   `main.html`, `side.html`, `package.json`, `cgi-bin` 등이 보이는 실제 사진을
   제공한다.
6. 패키지 화면을 열고 New Job으로 이동한다.
7. Database 기본값은 그대로 두고, LS DeviceString과 DataCount만 입력한다.
8. 자동 생성된 Tag를 확인한 뒤 Job을 생성하고 시작한다.
9. Data Viewer에서 저장 결과를 확인한다.

빠른 시작에서는 세부 설정 의미를 반복하지 않고 관련 상세 장 링크만 제공한다.

### 2. 상세 설정

- **Job Configuration**: Job Name, Run Interval, Retry Initial/Maximum/Multiplier,
  Save Policy와 편집 모달을 설명한다.
- **Database**: 기본 localhost와 기본 Table, 기존/새 Table, Value Column,
  String Value Column, Job 생성 시 없는 Table 자동 생성 규칙을 설명한다.
- **Method Calls**: LS 고정 `GetDeviceData`, Call 추가·선택·순서 변경·삭제,
  DeviceString 선택기, DataCount, Test Call을 설명한다.
- **Tags**: 자동 이름, 수동 이름 보존, Bias, Multiplier, 계산 순서와 접기/펼치기를
  설명한다.
- **Import CSV**: `name,bias,multiplier,order` 열, 빈 값 기본값, 위에서부터
  DataCount만큼 적용, 초과 행 무시, 부족 행 유지, 오류 시 전체 취소를 설명한다.
- **운영 화면**: Start/Stop, Job 상세, Data Viewer, Logs를 설명한다.

## 핵심 규칙

- `%MB3`, DataCount `3`은 `MB3`, `MB4`, `MB5`를 만든다.
- 사용자가 직접 바꾼 Tag 이름은 DeviceString 또는 DataCount가 바뀌어도 같은
  위치에서 유지한다.
- CSV로 가져온 Tag 이름도 수동 이름으로 취급하여 자동으로 바꾸지 않는다.
- DataCount가 줄어 범위를 벗어난 Tag는 수동 이름 여부와 관계없이 삭제된다.
- CSV의 `bias`, `multiplier`, `order`가 비면 각각 `0`, `1`, `0`을 쓴다.
- `order=0`은 `(value + bias) * multiplier`, `order=1`은
  `(value * multiplier) + bias`다.

## 이미지 계획

각 이미지는 실제 LS 빌드 화면에서 캡처하고 설명 문장 바로 아래에 배치한다.

1. Neo Web File Explorer의 `public/neo-pkg-dbus` 파일 목록
2. LS 패키지 첫 화면과 New Job 진입
3. 기본값이 채워진 Job 생성 화면
4. DeviceString 주소 선택기와 DataCount
5. 자동 생성된 Tags와 펼친 상세
6. Import CSV 버튼 및 반영 결과
7. Job 생성 뒤 Side Start/Stop과 Job 상세
8. Data Viewer의 Tag 선택과 결과
9. Job Configuration 편집 모달
10. Database 편집 모달

비밀번호, 접속 토큰, 개인 경로와 불필요한 테스트 Job은 캡처에서 제외한다.

## 개발 중 안내

문서 첫 부분과 제한 사항 장에 다음을 명시한다.

- 제공 버전은 운영용 정식 릴리스가 아니라 기능 확인을 위한 개발 중 테스트 빌드다.
- Logs 기능은 현재 수정 중이다.
- PLC 메모리에 값이 없을 때 장비 응답 형태에 따라 출력 파싱 오류가 발생할 수
  있으며 현재 수정 중이다.
- 테스트 결과를 운영 안정성, 장기 실행, 장애 복구 보장으로 표현하지 않는다.

## 확인 기준

- 최신 Neo Linux/Docker 명령은 Machbase 공식 저장소·문서를 근거로 한다.
- 저장소의 실제 package 이름, 최소 Neo 버전, LS 화면과 계약을 사용한다.
- 모든 빠른 시작 단계에 명령, 성공 판별 방법, 관련 화면 또는 필요한 설명이 있다.
- 깨진 이미지 링크나 작성 중 표시가 없다.
- Google Docs로 복사했을 때 이해에 필요한 내용이 링크에만 의존하지 않는다.

## 승인

2026-08-14 사용자 승인: 순서형 빠른 시작을 사용하고, Database 기본값 설명은
뒤로 옮기며, Neo Web File Explorer에서 `public/neo-pkg-dbus` 안의 실제 파일이
보이는 사진을 포함한다.
