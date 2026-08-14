# OPC UA DataViewer 공통 이식 설계

## 승인된 결정

2026-08-11 사용자가 `neo-pkg-opcua-client`의 DataViewer를 화면 일부가 아니라
코드·동작 기준으로 공통 DBus 패키지에 그대로 가져오고, 필요한 DBus 계약도
변경하도록 승인했다.

## 목표

공통 브랜치에 OPC UA DataViewer의 태그 탐색, 다중 선택, Raw Grid, 시간 범위,
페이지 이동, 통계 기반 첫·끝 페이지, Chart, 분할 Chart, 줌·팬, 시간 표시 형식과
timezone 선택, Asset hierarchy, Derived Tag 표시, Neo Web Tag Analyzer 연결을
옮긴다. 일반판과 LS판은 이 공통 커밋을 rebase해 동일 화면을 쓴다.

## 경계

- DBus Job은 DataViewer가 사용할 DB server, table, numeric/string value column을
  정하는 기준점으로 남는다.
- Tag 목록과 DataViewer 조회는 Job이 기록한 Tag만으로 제한하지 않고, 그 Job의
  Database table 전체 Tag를 대상으로 한다.
- Job의 DB server/table/column과 요청값이 같은지는 계속 Backend에서 검증한다.
- 원본의 client-side Chart는 Neo Web `/web/api/query`를 사용한다. DBus CGI Chart API는
  검증된 SQL query만 돌려주며 브라우저가 Neo Web 로그인 토큰으로 실행한다.
- 저장된 timestamp와 CGI API 입력·응답의 정규 표현은 UTC ISO-8601이다. 화면은
  원본처럼 UTC/LOCAL/IANA timezone과 시간 표시 형식을 골라 표시만 바꾼다.
- Asset hierarchy가 없는 TAG table은 원본 화면에서 Asset tab을 숨기고, Job에
  `derivedTags`가 없으면 Derived Tag 행은 비어 있다. 두 경우에도 다른 원본 기능은
  정상 동작한다.

## API 변경

- `GET /db/table/tags`는 `{ tags, assetHierarchy }`를 반환한다.
- `GET /db/table/data`는 `page`, `pageSize`, `boundedRange`, keyset cursor,
  `includeTotal`을 지원한다. `includeTotal=true`는 `{ total, lastPage }`를 반환한다.
- `GET /db/table/stat`은 선택 Tag의 가장 이른/늦은 기록 시간을 반환한다.
- `GET /db/table/chart`는 화면이 Neo Web으로 실행할 검증된 `{ query }`를 반환한다.
- `tags`는 `job`, `server`, `table`을 요구한다. `data`, `stat`, `chart`는 여기에
  `names`도 요구한다. names는 해당 table의 실제 Tag이면 되고 Job 설정의 Tag 배열에
  있을 필요는 없다.

## 검증

Backend는 tag 범위, table/column mismatch, page/keyset, total, stat, asset hierarchy,
chart SQL을 단위 테스트한다. Frontend는 원본 `dataViewerModel`의 테스트와 DBus API
adapter/route 테스트를 유지한다. 일반·LS 번들 build와 공통·각 배포판 테스트를
실행한다.
