# Design System

- Read `DESIGN.md` before creating or modifying frontend or UI code.
- Follow `DESIGN.md` for colors, typography, spacing, border radii, and component styles.
- Do not introduce design values that are not defined in `DESIGN.md`.
- If the existing code conflicts with `DESIGN.md`, tell the user before making the change.

# 계약 변경 관리

- 계약은 `docs/specs/DBUS_SDD.md`, `docs/specs/FE_DESIGN.md`, `docs/specs/BE_DESIGN.md`에 적힌 공개 API, 데이터 모델, 상태, 오류 코드, 화면 동작, 지원 환경의 약속이다.
- 계약과 다른 구현·테스트 결과·JSH 호환성 문제를 발견해도, 먼저 코드나 현재 계약 문서를 바꾸지 않는다.
- 변경이 필요하면 사용자에게 기존 계약, 바꿀 계약, 변경 이유, 영향 범위, 확인 근거와 미확인 위험을 설명하고 **명시적인 승인**을 받는다.
- 승인 전에는 조사 결과를 `미승인 제안`으로만 분리해 기록할 수 있다. 이를 현재 계약, 구현 완료, 출시 가능 상태로 표현하거나 동작에 적용하지 않는다.
- 승인 후에만 계약 변경을 구현한다. 같은 작업에서 `DBUS_SDD.md`에 이전 내용·새 내용·이유·근거·승인 상태를 기록하고, 영향을 받는 `FE_DESIGN.md`와 `BE_DESIGN.md`도 같은 계약을 참조하거나 갱신한다.
- 계약을 보존하는 버그 수정이나 문서 오탈자 수정은 승인 없이 진행할 수 있다. 계약 변경인지 불분명하면 계약 변경으로 보고 먼저 승인받는다.

# 커밋 전 기본 제품 빌드

- 모든 커밋 직전에 저장소 루트에서 인자 없이 `npm run build`를 실행하고 성공을 확인한다. 빌드가 실패하거나 이 명령이 아직 구현되지 않았으면 커밋하지 않는다.
- 인자 없는 `npm run build`는 항상 기본 `generic` 제품을 빌드해야 한다. `npm run build -- --target=generic`도 같은 결과를 만들어야 한다.
- Git에 추적·커밋하는 완성 package 산출물은 기본 `generic` 빌드 결과만 허용한다.
- LS 또는 다른 업체 target을 빌드한 뒤에는 커밋 전에 반드시 인자 없는 `npm run build`를 다시 실행해 루트 산출물을 `generic`으로 되돌린다.
- `provider.json`, 업체 전용 Interface, 업체 전용 Backend·Frontend 산출물처럼 다른 업체 build에서만 생기는 파일이 루트 완성 package에 남아 있으면 커밋하지 않는다.
- 제품별 source는 커밋할 수 있지만, `npm run build -- --target=ls` 또는 다른 업체 target이 만든 완성 산출물 자체는 커밋하지 않는다.
