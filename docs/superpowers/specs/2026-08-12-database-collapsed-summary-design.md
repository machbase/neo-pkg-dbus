# Database 접힘 요약 설계

> 2026-08-13 대체 기록: 이 문서의 Database 값과 저장 계약은 유지한다. 화면 안에서 접고 펼치는 규칙과 레이블 없는 요약은 `DBUS_SDD.md` CCR-058의 레이블이 있는 읽기 전용 요약 카드 + `Edit Database` 모달로 대체한다. 모달은 별도 draft를 사용하고 Apply만 반영하며 Cancel·닫기·바깥 클릭·Esc는 버린다.

## 목적

Job 생성·수정 화면의 Database 섹션은 이미 기본적으로 접혀 있다. 현재는 접힌 상태에서 제목만 보여 선택된 Database Server와 Table을 확인하려면 섹션을 펼쳐야 한다. 접힌 상태에서도 현재 Database 연결 대상을 읽을 수 있도록 요약을 추가한다.

## 화면 동작

- New/Edit Job의 Database 섹션은 지금처럼 route 진입 시 기본적으로 접는다.
- 접힌 제목 행은 왼쪽에 `DATABASE`, 오른쪽에 현재 `Database Server / Table` 값을 표시하고 마지막에 펼침 버튼을 둔다.
- 요약은 레이블 없이 값만 표시한다. 예시는 `localhost / DEFAULT_DBUS`다.
- Server 또는 Table이 비어 있으면 해당 위치에 `—`를 표시한다. 둘 다 비어 있으면 `— / —`다.
- 요약은 `span` 기반 읽기 전용 텍스트다. input, select, link 또는 별도 동작 버튼을 넣지 않는다.
- 펼침 버튼은 기존 `Toggle Database` label과 `aria-expanded` 상태를 유지한다.
- 펼친 상태에서는 기존 Database Server, Table, Value Column, String Value Column control과 Table 자동 생성 안내를 그대로 표시한다.
- 펼친 상태에서 Server 또는 Table을 바꾸고 다시 접으면 요약은 별도 복사본 없이 현재 Job draft를 즉시 표시한다.

## 구현 경계

- 기존 `databaseOpen` 상태와 공통 `JobForm`을 사용한다.
- Job Configuration과 같은 title-row 배치 규칙을 사용하되 Database 전용 값만 표시한다.
- 공통 Disclosure 컴포넌트나 HTML `details`로 구조를 바꾸지 않는다. 두 섹션만을 위한 추상화는 만들지 않는다.
- API, Backend, Job schema, 저장 payload와 Database 유효성 검증은 변경하지 않는다.
- generic과 LS target은 같은 공통 화면 구현을 사용한다.
- 색상, 글꼴, 간격은 `DESIGN.md`의 기존 token과 Job Configuration summary 규칙을 재사용한다.

## 오류와 빈 값

- Database 기본값을 아직 불러오지 못했거나 사용자가 값을 지운 상태에서도 화면 오류를 만들지 않고 `—`를 표시한다.
- 기존 Database API 오류는 현재 Notice 흐름으로 표시하며 요약에 오류 문구나 상태 badge를 추가하지 않는다.

## 검증 기준

- New/Edit Job 최초 렌더에서 Database가 접혀 있고 현재 Server/Table을 값만으로 표시하는지 확인한다.
- Server/Table이 비어 있으면 `— / —`가 보이는지 확인한다.
- 요약 안에 form control이 없고 펼침 버튼에 `aria-expanded=false`가 있는지 확인한다.
- 섹션을 펼쳐 Server/Table을 바꾸고 다시 접었을 때 현재 값이 표시되는 렌더 상호작용 테스트를 추가한다.
- 기존 Column control, Table 목록, 자동 생성 안내와 저장 payload 테스트가 계속 통과하는지 확인한다.
- generic과 LS 제품 테스트 및 인자 없는 최종 generic build를 확인한다.

## 승인

- 2026-08-12 사용자 요청: Database도 접힌 상태에서 Database Server와 Table을 읽기 전용으로 표시한다.
- 2026-08-12 사용자 선택: 레이블 없이 값만 표시한다.
- 2026-08-12 사용자 승인: 기존 Job Configuration과 같은 단순 요약 구조로 진행한다.
