# PLC DBus Long-term Test Record

## 목적과 운영 원칙

- 대상: LS PLC `192.168.1.55`, Docker container `machbase-neo-test` (Neo 8.5.11)
- 기본 조건: `intervalMs: 10`, overrun policy `skip`, Go reader와 단일 persistent native writer
- 순서: A(1,000 x 1) → 재시작 → B(500 x 2) → 재시작 → C(250 x 4) → 재시작 → D(서로 다른 시작 주소의 두 Job) → 재시작
- A~C는 완료 후 Job/table/log를 정리한다. D는 Job만 stop하고 config, table, log, runtime 결과를 보존한다.
- 각 실행 중에는 runtime checkpoint, 저장 행 수, queue depth, overrun, disk, API health와 Job log를 함께 확인한다.

## 2026-09-01 사전 배포·용량 검증

### 발견·수정한 배포 문제

1. ZIP 설치본에서 `neo-dbus-launcher.js`와 `neo-dbus-control.js`의 mode가 `0644`였다.
   Job Start는 control script를 실행하므로 binary만 `0755`로 보정해서는 충분하지 않았다.
2. JSH `process.exec()`에 `@<script.js>`를 전달했다. `@`는 OS command 실행용이라 Linux에서
   `exec format error`가 발생했다. JSH script 경로 자체를 전달해야 한다.
3. PLC package의 Go collector SHA-256이 local LS build와 달랐다. JSH/runtime만 교체하면
   logging·runtime 동작이 이전 binary와 섞인다.

수정 내용:

- LS install/runtime의 executable 보정 대상을 Go binary, launcher, control script 세 파일로 확대했다.
- logical Job control을 `process.exec(files.control, action, name)`으로 변경했다.
- 관련 Node test 및 Go test를 통과시켰고, `cgi-bin/runtime.js`와 Go binary를 다시 build했다.
- PLC에는 runtime, lifecycle, Go binary를 같은 build로 동기화했고 final binary SHA-256은
  `e053660abfdfb9881b3317a930275ee13aa87e0a0770bf8b9ec4fa7a776e8418`로 local과 일치한다.

### 2026-09-02 lifecycle 보완

1. Neo 재시작 뒤 active-job checkpoint는 남았지만 collector service가 재기동하지 않았다.
   원인은 LS runtime descriptor에 지정한 `enable: false`였다. descriptor를 명시적
   `enable: true`로 바꿨고, package lifecycle의 inline `servicectl install`에도 `--enable`을 추가했다.
2. GitHub ZIP 추출본은 native binary뿐 아니라 package lifecycle script와 JSH launcher/control의
   execute bit도 잃을 수 있다. product build가 `scripts/{install,start,stop,uninstall}.js`,
   launcher/control, Go binary 모두를 `0755`로 보정하도록 변경했다.
3. 실제 PLC에서 `pkg run ... uninstall`을 실행해 본 결과, relative `require('./lifecycle.js')`가
   JSH package command resolution에서 실패했다. lifecycle entry script는 `process.argv[1]`의
   절대 directory를 기준으로 `lifecycle.js`를 load하도록 변경했다.

위 세 변경 뒤 LS build와 product/lifecycle Node tests를 다시 통과시켰다. 이제 PLC에서
package lifecycle command와 service 재등록을 재검증한다.

### A 사전 run (유효한 장시간 결과로 사용하지 않음)

`lt-a-1000`, `%MB0`, 1,000 byte, 10ms, `DBUS_LT_A_1000`을 약 112초 실행했다.
이 run은 시작 직전에 PLC binary mismatch를 발견했으므로 long-term 비교 결과에는 넣지 않는다.
다만 실제 storage rate를 판단하는 안전 점검으로 사용한다.

| 항목 | 관측값 |
|---|---:|
| persisted rows | 8,442,000 |
| runtime queue depth | 0 |
| queue-full skip | 0 |
| scheduler overrun | 2,747 |
| table drop으로 회수된 space | 261,705,728 bytes |
| 관측 저장 공간 | 약 31 bytes / persisted row |
| 추정 지속 저장률 | 약 2.34 MB/s, 약 8.4 GB/h |

사전 run 뒤 logical Job을 stop했지만 persistent writer가 appender를 계속 열고 있어 table drop은
`Resource busy`로 거부됐다. Neo container를 정상 재시작해 writer를 종료한 뒤
`DROP TABLE DBUS_LT_A_1000 CASCADE`를 실행했고, `/data` free space는 2,120,888,320 bytes가 됐다.
이는 시나리오별 재시작 뒤 정리 순서를 지켜야 하는 이유이기도 하다.

### 로그 확인

사전 run의 log에는 lifecycle start/stop과 scheduler overrun이 남았다. 그러나 이 log는 이전
Go binary가 만든 것이어서 현재 summary 정책 검증의 근거로 사용하지 않는다. 최신 binary로
재시작하는 유효 시나리오에서는 다음을 검증한다.

- 정상: lifecycle/config 변경만 INFO, debug level에서 interval summary
- 첫 skip/error: 즉시 WARN/ERROR
- 반복 skip/error: `settings.logging.summaryIntervalMs` 주기의 summary
- stop 또는 daemon shutdown: 강제 summary 후 lifecycle stop
- rotation: 1MiB, 3개 파일 한도

## 장시간 실행 전 blocker

container `/data`의 현재 여유는 약 2.12GB다. 위 관측률이라면 10ms/1,000건 Job 하나만으로도
안전 여유를 제외하면 약 15분 내외에 이 공간을 소비할 수 있다. 13시간 시험을 같은 10ms 조건으로
수행하면 DB full 위험이 확실하므로, 아래 중 하나가 결정되기 전에는 유효 장시간 시나리오를 시작하지
않는다.

1. Neo data volume의 여유 공간을 충분히 늘린다. 10ms 1,000건 기준 13시간은 관측치로 약 110GB가 필요하다.
2. 장시간 안정성 시험의 interval/data rate를 낮춘다. 이 경우 10ms 성능 시험과 별도 결과로 기록한다.
3. A~C는 짧은 10ms 기능·재시작 시험으로 제한하고, D만 보존 가능한 저율 조건으로 장시간 실행한다.

마지막 D 결과 보존 요구 때문에 기존 사용자 data나 Docker backup/image를 임의로 삭제하지 않는다.

## 2026-09-02 A — 1,000 byte x 1 Job, 10ms

`lt-a-1000` (`%MB0`, `DataCount:1000`, `DBUS_LT_A_1000`)을 최신 LS build에서 실행했다.

- 정상 수집, native writer queue depth 0을 확인했다.
- 10ms에는 DBus read의 간헐 지연으로 scheduler skip이 발생했다. 이는 설정된 skip 정책이며,
  queue-full skip은 0이었다.
- Neo restart 뒤 enabled shared service와 active-job checkpoint로 Job이 자동 복구되었다.
  복구 직후 `lastStoredAt`와 overrun count가 새 값으로 진행되는 것을 API로 확인했다.
- Job stop 시 강제 summary가 기록됐다: 28.062초, 성공 cycle 2,174건, 저장 2,174,000 rows,
  scheduler skip 617건, queue skip 0건. 이어 collector stopped INFO가 기록됐다.
- A 결과는 정책대로 Job config와 table, log를 모두 정리했다. table drop 후 `/data` free는
  1,838,981,120 bytes였다.

## 2026-09-02 B — 500 byte x 2 Jobs, 10ms

`lt-b-500-1`, `lt-b-500-2`를 `%MB0`에서 각각 500 byte씩 읽고, 동일 table
`DBUS_LT_B_500`과 shared persistent writer로 실행했다.

- 두 Job이 동시에 정상 수집했고, Neo restart 뒤 두 Job 모두 automatic recovery 됐다.
- stop summary: Job 1은 30.419초/2,199 cycles/1,099,500 rows/828 scheduler skips,
  Job 2는 30.861초/2,208 cycles/1,104,000 rows/859 scheduler skips였다.
  두 경우 모두 failed=0, queueSkipped=0이다.
- B Job config/table/log를 정리했다. table drop 뒤 `/data` free는 1,883,385,856 bytes였다.

## 2026-09-02 C — 250 byte x 4 Jobs, 10ms

`lt-c-250-1..4`를 `%MB0`에서 각각 250 byte씩 읽고, 동일 table
`DBUS_LT_C_250`과 shared persistent writer로 실행했다.

- 네 Job 모두 정상 수집했고 Neo restart 후에도 모두 automatic recovery 됐다.
- stop summary는 각 Job 순서대로 335,000 / 349,500 / 356,500 / 361,750 rows를 기록했다.
  성공 외 DBus/DB 오류는 없었고, queueSkipped는 네 Job 모두 0이었다. scheduler skip은
  1,488 / 1,469 / 1,480 / 1,500으로, 10ms에서 DBus 응답 변동을 skip으로 흡수했다.
- C Job config/table/log를 정리했다. table drop 뒤 `/data` free는 1,898,098,688 bytes였다.

## 2026-09-02 D — 장시간 보존 run 시작

- `lt-d-mb0`: `%MB0`, 1,000 byte, 2,000ms
- `lt-d-mb1000`: `%MB1000`, 1,000 byte, 2,000ms
- 두 Job은 `DBUS_LT_D_ADDR` 하나와 shared persistent writer를 사용한다.

시작 후 runtime baseline에서 두 Job은 각각 45,000 / 44,000 rows, queueDepth 0,
overrun 0, queueSkipped 0이었다. 약 80초 뒤 85,000 / 84,000 rows로 증가했고 모든 overrun/error는
계속 0이었다. SQL `COUNT(*)` baseline은 89,000 rows였다. table 생성 초기 allocation 뒤 `/data`
free는 1,695,711,232 bytes에서 추가 80초 동안 변하지 않았다. 이 run은 보존 대상이므로 Job/table/log/
runtime artifact를 삭제하지 않는다. 장시간 운용 뒤 Neo restart recovery와 stop-only 상태를 검증한다.
