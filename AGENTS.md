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

# LS 제품 기준과 커밋 전 빌드

- 별도 사용자 지시가 없는 한 수정·검증·배포·최종 커밋 산출물은 **LS** 기준이다. 2026-10-13 사용자 확인이며, 이전 generic 커밋 규칙을 대체한다.
- 모든 커밋 직전에 저장소 루트에서 `npm run build -- --target=ls`를 실행하고 성공을 확인한다. 실패하면 커밋하지 않는다.
- 완성 package의 HTML, LS Provider·Interface·Backend asset과 `cgi-bin/bin/neo-dbus-collector`는 LS 빌드 결과로 준비한다. Collector 실행 권한은 755를 확인한다.
- LS 빌드 뒤 인자 없는 `npm run build`를 실행해 generic으로 되돌리지 않는다. 현재 인자 없는 빌드는 generic을 선택하므로 LS target을 명시한다.
- generic source는 향후 사용을 위해 보관만 한다. 별도 요청 전에는 generic 전용 수정·검증·완성 산출물 준비를 작업 범위에 넣지 않는다.
- Git commit/push/merge, 버전 변경, ZIP 생성과 release는 각각 사용자 지시를 기다린다.

# PLC 시험 CPU 기준

- 2026-10-27 사용자 지시에 따라 이후 테스트 PLC의 Docker CPU 기본값은 `--cpuset-cpus 6,7`로 한다. 다른 CPU를 명시한 시험은 해당 지시를 따른다.
- 이전 CPU 4·5 측정 기록은 그대로 보존하고, CPU 6·7 결과와 구분한다. CPU 번호 고정은 전용 CPU 격리를 뜻하지 않는다.
- PLC 제어 프로세스·스레드의 affinity나 우선순위는 시험을 위해 임의로 변경하지 않는다.
