# PLC DBus 1000-byte / Native Append Benchmark Memo

## 1. 목적과 상태

- 측정일: 2026-08-31
- 대상 PLC: `192.168.1.55`
- 목적: LS PLC에서 DBus로 연속 byte 1000개를 읽고 Machbase Neo TAG table에
  저장할 때 10ms 주기가 가능한지 확인한다.
- 상태: 사전 JSH/Go 벤치마크와 LS Go daemon의 실제 PLC package-path 검증을 완료했다.
- 후속: LS 테스트 패키지를 PLC 개발 측에 전달할 때 이 결과와 overrun 로그를 함께
  전달한다.

이 문서는 결과를 잊지 않기 위한 작업 메모다. 제품의 성능 보증 문서가 아니다.

## 2. 책임 범위 결정

`ls.plc.device.GetDeviceData`에서 간헐적으로 발생하는 50~129ms 응답 지연은
PLC의 DBus provider 또는 PLC scan/lock 처리 구간에 대한 PLC 개발 측 확인
사항이다. 이 지연 자체를 `neo-pkg-dbus`의 결함이나 책임 범위로 보지 않는다.

패키지 책임 범위는 다음과 같다.

- Machbase native connection과 appender는 single writer goroutine 안에서 계속 유지한다.
- cycle 완료 후 interval을 더하는 방식이 아니라 fixed-rate 예정 시각을 사용한다.
- 예정 시각이 겹치거나 queue가 가득 차면 항상 `skip`한다. `stop` 선택은 DBus
  provider 지연 원인이 확인된 뒤에만 다시 검토한다.
- overrun 누적 건수와 마지막 발생 시각은 daemon checkpoint에만 두고, rate-limited
  Job 로그에도 남긴다. 현재 Frontend와 공개 API에는 표시하지 않는다.
- 1ms 같은 짧은 interval은 best-effort 설정값이며 hard real-time 보장을 의미하지
  않는다.

## 3. 환경과 측정 방법

- Machbase Neo: `v8.5.7-snapshot` (8.5.8 내부 빌드)
- Neo 실행: Docker `machbase-neo-test`
- JSH 실행 파일: `/opt/machbase-neo`
- 고해상도 시각: JSH `process.hrtime()`
- DBus bus: System
- destination: `ls.plc`
- object path: `/ls/plc/device`
- method: `ls.plc.device.GetDeviceData`
- args: `uint16:1000`, `string:%MB0`
- 응답: JSON 문자열 약 2,091 bytes, `/data` 배열 원소 1,000개
- 저장: 임시 TAG table에 `MB0`~`MB999` 1,000행/cycle
- DB 연결: native `machcli`, `127.0.0.1:5656`

측정은 현재 패키지를 배포하지 않고 독립 JSH 코드로 수행했다. Transform, Job
validation, logging, service details 갱신 등의 패키지 비용은 포함하지 않았다.
따라서 패키지 전체 cycle 시간은 이 결과와 같거나 더 길 수 있다.

벤치마크용 TAG table은 HTTP DDL로 삭제를 요청했다. 다만 이번 장시간 native
append timeout 뒤에는 `DROP TABLE ... CASCADE`가 성공을 반환했어도 일부
`DBUS_Q_*` catalog entry가 남는 현상을 확인했다. 이 상태에서는 임의의 raw artifact
삭제나 Neo 재시작을 하지 않았다.

## 4. Persistent Appender 전체 파이프라인

appender를 한 번 열고 유지한 상태에서 워밍업 5회 후 50회 측정했다.

| 단계 | 평균 | 최소 | 최대 | p95 |
|---|---:|---:|---:|---:|
| DBus read | 4.235ms | 2.063ms | 5.744ms | 5.068ms |
| JSON parse | 0.945ms | 0.889ms | 1.210ms | 0.993ms |
| native append 1000행 + flush | 6.952ms | 6.386ms | 9.277ms | 9.105ms |
| read + parse + append + flush | 12.131ms | 9.644ms | 15.269ms | 14.685ms |

정상 구간에서도 평균 전체 시간은 10ms를 넘었다.

## 5. Append와 Flush 분리

같은 persistent appender에서 워밍업 5회 후 100회 측정했다.

| 단계 | 평균 | 최소 | 최대 | p95 |
|---|---:|---:|---:|---:|
| DBus read | 6.002ms | 1.882ms | 122.256ms | 4.601ms |
| JSON parse | 0.984ms | 0.887ms | 2.388ms | 1.029ms |
| native `appender.append()` 1000회 | 6.977ms | 6.499ms | 12.903ms | 8.480ms |
| native `flush()` | 0.124ms | 0.031ms | 1.309ms | 0.174ms |
| 전체 | 14.088ms | 9.564ms | 130.203ms | 14.192ms |

- 10ms 안에 전체 작업을 완료한 횟수: 4/100 (4%)
- `flush()` 비용은 작으므로 flush 주기를 늦추는 것만으로는 10ms 문제가 해결되지
  않는다.
- JSH에서 1,000번 수행하는 행 단위 append 호출이 평균 약 7ms를 차지한다.

## 6. Appender Lifecycle 비교

| 방식 | 1000행 저장 평균 | 최소 | 최대 |
|---|---:|---:|---:|
| connection/appender 계속 유지 | 6.952ms | 6.386ms | 9.277ms |
| connection 유지, cycle마다 appender reopen | 8.011ms | 7.433ms | 9.059ms |
| cycle마다 client connect + appender open | 10.190ms | 9.565ms | 11.280ms |

참고 setup 비용:

- 최초 native connect: 2.733ms
- 최초 persistent appender open: 2.800ms
- 임시 TAG table 생성: 754.349ms (Job cycle 성능에는 포함하지 않음)

결론은 Job 시작 시 native connection과 appender를 한 번 열고, Job 종료까지 유지해야
한다는 것이다.

## 7. 저장 없는 DBus Read 측정

### 7.1 연속 호출 200회

저장 없이 워밍업 10회 후 DBus read와 JSON parse를 연속 200회 실행했다.

| 단계 | 평균 | 최소 | 최대 | p95 | p99 |
|---|---:|---:|---:|---:|---:|
| DBus read | 3.048ms | 1.813ms | 3.464ms | 3.372ms | 3.415ms |
| JSON parse | 0.934ms | 0.872ms | 2.580ms | 1.003ms | 1.785ms |
| 합계 | 3.982ms | 2.714ms | 5.380ms | 4.319ms | 4.715ms |

이 측정에서는 200/200회가 10ms 이내였다. 그러나 연속 최대 속도 호출과 실제 10ms
fixed-rate timer 결과는 달랐다.

### 7.2 실제 10ms Fixed-rate, 각 10초

저장은 하지 않고 10ms 간격으로 1,000개 예정 tick을 만든 뒤, 이전 호출이 끝나지
않은 tick은 catch-up하지 않고 skip했다.

| 실행 | 예정 tick | 실제 실행 | skip | deadline miss | 평균 read+parse | 최대 |
|---|---:|---:|---:|---:|---:|---:|
| 1차 | 1000 | 786 | 214 | 25 | 7.550ms | 129.025ms |
| 2차 | 1000 | 782 | 218 | 25 | 7.651ms | 125.354ms |

- 실제 timer 시작 지연 최대: 1차 0.270ms, 2차 0.174ms
- p95 read+parse: 1차 6.108ms, 2차 6.181ms
- p99 read+parse: 1차 101.970ms, 2차 102.184ms
- 장시간 지연은 JSON parse가 아니라 DBus call 안에서 발생했다.

## 8. DBus 장시간 지연 표본

5초, 10ms fixed-rate 추가 측정에서 10ms를 넘긴 호출만 기록했다.

| 예정 시각 | DBus read | JSON parse | 합계 |
|---:|---:|---:|---:|
| 0ms | 107.810ms | 1.059ms | 108.869ms |
| 110ms | 105.619ms | 1.007ms | 106.626ms |
| 220ms | 61.643ms | 1.037ms | 62.680ms |
| 1580ms | 122.853ms | 1.004ms | 123.856ms |
| 1710ms | 97.951ms | 0.982ms | 98.933ms |
| 1810ms | 103.371ms | 0.918ms | 104.289ms |
| 1920ms | 97.674ms | 0.921ms | 98.595ms |
| 2020ms | 99.451ms | 0.966ms | 100.417ms |
| 2120ms | 102.386ms | 0.939ms | 103.325ms |
| 2230ms | 98.213ms | 0.903ms | 99.115ms |
| 2330ms | 52.819ms | 0.931ms | 53.750ms |
| 3580ms | 119.883ms | 0.936ms | 120.819ms |
| 3700ms | 99.311ms | 0.894ms | 100.204ms |
| 3810ms | 95.641ms | 0.919ms | 96.561ms |
| 3910ms | 95.390ms | 0.933ms | 96.323ms |
| 4010ms | 97.732ms | 1.161ms | 98.893ms |
| 4110ms | 98.053ms | 0.933ms | 98.986ms |
| 4210ms | 98.707ms | 0.918ms | 99.625ms |
| 4310ms | 99.847ms | 0.943ms | 100.789ms |
| 4420ms | 63.789ms | 0.907ms | 64.696ms |

이 5초 표본에서는 예정 tick 500개 중 319회 실행, 181회 skip됐다. 지연이 단발성이
아니라 군집해서 나타났다.

## 9. Read/Write 분리 queue 추가 측정

### 9.1 방식

DBus read/JSON parse와 DB 저장을 서로 다른 JSH process로 분리하고 localhost TCP로
전달했다. queue에는 reader id, 예정 시각, sequence와 1,000 byte 값을 넣고 writer가
`flush()` 완료 후 ACK를 돌려줬다. 따라서 ACK 미수신 수는 저장 대기 backlog다.

- JSON으로 1,000개 숫자 배열을 전달하면 reader의 serialize/socket write가 평균
  9.930ms여서 탈락했다.
- 고정 길이 binary frame(1,036 bytes)에서는 pack/socket write가 평균 약 3ms였다.
- writer는 native connection/appender 하나를 열어 계속 유지했다.

### 9.2 Synthetic input (1000 byte, 10ms) 결과

| 구성 | 주요 결과 | 판단 |
|---|---|---|
| reader 1 / writer 1 | 300 예정 중 298 실행, writer 298 batch 저장. queue 대기 평균 3.559ms, append 평균 7.240ms, 예정 시각→저장 평균 10.795ms (최대 34.576ms) | nominal load는 처리 가능하나 end-to-end 10ms 보장은 불가 |
| reader 2 / writer 1 | 581 batch 저장. queue 대기 평균 844.657ms, 최대 1,559.623ms | 1000행×100Hz reader 두 개를 writer 하나가 감당하지 못함 |
| reader 2 / writer 2, 같은 TAG table | append 최대 388.200ms / 423.339ms, queue 대기 평균 263~299ms | concurrent appender contention으로 불안정 |
| reader 2 / writer 2, 서로 다른 TAG table | 각 writer가 약 43 batch 뒤 native write I/O timeout | 다중 native writer를 채택하면 안 됨 |

두 writer/서로 다른 table 시험의 error는 다음과 같았다.

```
MACHCLI write tcp 127.0.0.1:<ephemeral>->127.0.0.1:5656: i/o timeout
```

### 9.3 실제 DBus reader 1 / persistent writer 1

300개 예정 tick(10ms)을 시험했다.

| 항목 | 결과 |
|---|---:|
| reader 실행 / skip | 132 / 168 |
| DBus read 평균 / p95 / 최대 | 16.001ms / 119.159ms / 160.425ms |
| JSON parse 평균 | 0.947ms |
| binary pack/socket write 평균 | 2.856ms |
| writer가 timeout 전 저장 완료로 기록한 batch | 43 |
| timeout 전 native append 평균 / 최대 | 7.106ms / 10.136ms |
| timeout 전 예정 시각→저장 평균 / p95 | 31.556ms / 129.682ms |

writer는 약 61초 뒤 native write I/O timeout으로 종료했다. 실패 후 DB 조회의 행 수가
writer 내부 `storedMessages × 1000`과 일치하지 않았으므로, timeout 뒤의 in-memory
counter를 durable write 완료의 근거로 사용하면 안 된다. 같은 container에서 20행 단건
append는 `close() = [20, 0]`, DB count 20으로 정상 확인됐지만, 1,000행 단건 append
재현은 100초 이상 block되어 중단했다.

이 결과는 이 PLC의 `8.5.7-snapshot` Neo/JSH/native client 조합에서 관측된 현상이다.
원인 확정 전에는 일반 Neo의 보편적인 동작으로 단정하지 않는다.

### 9.4 Queue에 대한 현재 결정

1. read와 write를 분리하는 bounded queue 자체는 가능하며, reader가 DB append block에
   직접 묶이지 않는 장점이 있다.
2. queue payload는 JSON이 아니라 binary/typed representation이어야 한다.
3. persistent appender는 reopen보다 빠르므로 유지한다. 다만 단일 writer도 1,000행
   append가 장시간 block될 수 있으므로 queue capacity, append timeout, ACK 기반
   durability 확인과 backpressure 정책이 필수다.
4. 현재 결과만으로는 여러 read job을 하나의 100Hz/1000행 writer에 합치면 안 된다.
   aggregate write rate가 writer 처리량을 넘으면 backlog가 계속 증가한다.
5. 여러 native writer를 동시에 두는 방식도 현 시점에서는 금지한다. 같은 table에서는
   심한 contention이, 다른 table에서는 I/O timeout이 발생했다.
6. 따라서 이번 패키지 변경에 queue writer pool을 바로 넣지 않는다. Neo/native append
   timeout의 재현·원인 확인과 batch/bulk API 검증이 선행돼야 한다.

### 9.5 Go native connector 비교 (추가 측정)

JSH 자체의 행 단위 append 비용을 분리하기 위해 Go로 동일한 DBus read/JSON parse와
native append를 측정했다.

- Go DBus: `github.com/godbus/dbus/v5` System bus
- Go DB: `github.com/machbase/neo-client/v2` (`96ae5ef`) persistent Appender
- Appender: 전용 native connection 하나, `WithBatchMaxRows(1000)`,
  `WithBatchMaxDelay(0)`, 매 cycle `Flush()`
- 동일한 `GetDeviceData(1000, "%MB0")`, 5회 warmup + 50회 측정, 총 4회 반복
- 각 run에서 `Appender.Close()` 결과: success 55,000 rows, fail 0

| Go run | DBus read p50 / p95 / max | JSON parse p50 | append 1000행+flush p50 / p95 / max | 전체 p50 / p95 / max |
|---|---:|---:|---:|---:|
| 1 | 2.781 / 3.086 / 51.712ms | 0.210ms | 1.011 / 2.061 / 133.679ms | 4.074 / 6.420 / 136.822ms |
| 2 | 2.550 / 3.307 / 6.042ms | 0.210ms | 1.019 / 1.794 / 189.585ms | 4.128 / 5.921 / 192.775ms |
| 3 | 2.872 / 6.222 / 126.188ms | 0.212ms | 1.017 / 1.567 / 209.819ms | 4.118 / 100.957 / 212.436ms |
| 4 | 2.794 / 105.249 / 156.176ms | 0.204ms | 1.017 / 1.397 / 1.708ms | 4.053 / 107.162 / 157.650ms |

정상 구간 비교:

- JSH JSON parse 중앙값 약 0.9ms → Go 약 0.2ms
- JSH persistent appender 1,000행 평균 약 7ms → Go native appender 중앙값 약 1ms
- JSH 전체 중앙값 약 10~14ms → Go 전체 중앙값 약 4.1ms

Go는 정상 경로의 10ms 목표에 여유를 만들었다. 그러나 DBus 105~156ms 및 native append
134~210ms outlier도 남아 있다. 즉 Go collector는 JSH의 정상 처리 병목을 제거하는
유효한 방향이지만, PLC DBus provider 지연 및 Neo native append pause에 대한 timeout,
bounded queue, overrun 정책은 여전히 필요하다.

### 9.6 LS Go daemon package-path PLC verification (2026-08-31)

LS implementation was additionally executed inside `machbase-neo-test`, where
the System DBus socket and native port `127.0.0.1:5656` are available. The
test used a dedicated `DBUS_GO_TEST` TAG table and removed it afterward.

| Scenario | Result |
|---|---|
| one Job, 10ms, 10 values/cycle | native append and checkpoint progressed; queue depth remained 0; DBus delay generated expected skip records |
| two Jobs, same table, one writer, 10ms, 10 values/cycle, 55s | `line-a` stored 48,150 rows, `line-b` 48,140 rows; queue depth and queue-full skip were both 0; one daemon process only |
| stop `line-b` while `line-a` runs | `line-b` retained its last read/store and changed to stopped; `line-a` continued from 37,500 to 59,750 stored rows |

A final binary (including retry and API-compatible Job logging) was re-run on
the same PLC for 4m 39s with two 10ms/10-value Jobs against the same table.
At the two-Job checkpoint, `line-a`/`line-b` had respectively stored
178,290/178,260 rows; both had queue depth 0, queue-full skip 0 and no error.
After stopping only `line-b`, `line-a` continued for more than one minute to
244,480 rows while `line-b` remained stopped at 178,260. Rate-limited
`[INFO]` lifecycle and `[WARN] scheduler` overrun records were readable in the
existing Job log format. The test also terminated an accidental diagnostic
`machbase-neo shell` process before final cleanup.

The first multi-Job run found that `dbus.SystemBus()` is shared by godbus, so
closing it at the end of every cycle made another Job fail with `use of closed
network connection`. The daemon was changed to open one dedicated persistent
`dbus.ConnectSystemBus()` connection per reader Job and close it only on Job
stop. The final 55-second run had no such error.

Cleanup was verified after the test: zero `neo-dbus-collector` processes,
removed host/container temporary directories, and no `DBUS_GO_TEST` catalog
entry.

## 10. 현재 판단

1. `GetDeviceData(1000, "%MB0")` read 자체는 보통 약 3~6ms다.
2. PLC DBus provider에서는 간헐적으로 약 50~129ms blocking이 발생한다.
3. 이 DBus 지연은 PLC 개발 측 조사 항목이다.
4. 행 단위 native append 1,000회는 persistent appender에서도 평균 약 7ms다.
5. 현재 단일 JSH cycle에서 1000-byte read와 1000 TAG 행 저장을 10ms 안에 안정적으로
   끝낼 수 없다.
6. appender/connection을 계속 유지하는 것은 필요하지만 그것만으로 10ms를 만족하지
   못한다.

10ms end-to-end가 절대 요구사항이면 향후 다음 대안을 별도로 검토한다.

- PLC DBus provider의 긴 blocking 제거 또는 cache/snapshot API 제공
- 1,000개 값을 1,000행이 아닌 한 행의 packed payload로 저장
- 변경 값만 저장
- 행 단위 JSH 호출이 아닌 bulk/native append 경로 제공
- read와 write를 별도 프로세스로 분리하고 bounded queue 사용
- PLC가 10ms sample을 내부 버퍼링하고 여러 sample을 한 번에 반환

## 11. 2026-09-01 PLC 8.5.11 재측정 — Job 분할 비교

LS PLC `192.168.1.55`의 `machbase-neo-test` (`8.5.11`) container 안에서 같은
Go DBus/native connector 경로로 다시 측정했다. `GetDeviceData`의 시작 주소는 모두
`%MB0`이며, writer는 persistent native Appender 하나만 열고 각 reader batch 뒤
`Flush()`했다. 각 scenario는 warm-up 10회 뒤 measured wave 600회, nominal interval
50ms로 실행했다. reader들은 한 wave 안에서 동시에 DBus를 읽고 writer는 단일
goroutine으로 batch를 순서대로 저장한다.

각 scenario는 전용 `DBUS_BENCH_*` TAG table을 만들었다가 완료 뒤 drop했다. 610,000행은
`(10 warm-up + 600 measured) × 1,000행`으로, DB count와 일치했다. host와 container에
옮긴 임시 benchmark executable도 종료 뒤 제거했다.

| 구성 | wave p50 / p95 / max | 50ms 초과 | DBus read 특성 | writer queue p95 | append+flush p95 |
|---|---:|---:|---|---:|---:|
| 1 Job × 1,000 | 5.373 / 104.168 / 126.706ms | 70/600 (11.7%) | p50 3.978ms, p95 102.626ms, max 125.329ms | 0.017ms | 1.255ms |
| 2 Jobs × 500 | 8.115 / 112.481 / 129.220ms | 90/600 (15.0%) | Job별 p50 6.161 / 5.143ms, max 157.649 / 140.491ms | 0.016ms | 0.567 / 0.574ms |
| 4 Jobs × 250 | 15.716 / 128.211 / 158.271ms | 81/600 (13.5%) | Job별 p50 7.451 / 10.546 / 14.190 / 5.347ms, max 129.708~157.807ms | 0.015ms | 0.302~0.307ms |

단일 1,000건 Job에서 JSON parse p50/p95는 `0.255/0.277ms`, writer queue p50/p95는
`0.013/0.017ms`, append+flush p50/p95는 `0.766/1.255ms`였다. 즉 DBus 응답 지연을
제외한 저장 경로는 p95 약 1.55ms(parse + queue + append/flush)이고, 병목은 writer가
아니다. 반면 실제 DBus를 포함한 정상 중앙 경로는 wave p50 `5.373ms`다.

### 11.1 interval 추론

`50ms` 이상으로 튀는 DBus provider 응답을 수집기 책임 범위 밖의 outlier로 **가정해도**,
단일 1,000건 Job의 실측 중앙 경로가 이미 `5.373ms`다. 따라서 `5ms`는 정상 중앙값보다도
짧아 fixed-rate 운용에 적합하지 않다. DBus의 일반 응답·Go scheduler 여유까지 포함한
현실적인 최소 운용 interval은 **10ms**로 판단한다. 7ms 부근은 이론적인 시험 후보일 수는
있지만, 이번 데이터만으로 안정적이라고 주장할 수 없다.

DBus 호출을 완전히 제외하고 parse + queue + native append/flush만 보는 내부 writer
capacity는 p95 약 `1.55ms`이므로, DB 저장만으로 10ms 목표가 막히지는 않는다. 그러나
현재 provider의 100~158ms 지연은 10ms scheduler에서 skip으로 관측될 것이며, interval을
더 줄여도 이 현상은 해결되지 않는다.

또한 같은 총 1,000건을 2개·4개 Job으로 분할하면 writer queue는 여전히 거의 0ms지만
wave p50이 `5.373 → 8.115 → 15.716ms`로 증가했다. 이 PLC에서는 단일 writer는 유지하되,
단일 1,000건 read를 여러 동시 DBus read Job으로 분할해 throughput을 높이는 방식은
채택하지 않는다.

### 11.2 두 Job의 영구 위상 분리(5ms) 시험

Job 시작 때만 한 번 지연하는 방식은 다음 fixed-rate deadline에서 다시 충돌하므로, 이
시험에서는 두 번째 Job의 모든 예정 시각을 첫 번째 Job보다 `5ms` 뒤로 두었다. 이는
benchmark 전용 옵션이며, package Job 설정이나 scheduler에는 아직 추가하지 않았다.
두 Job은 각각 500 byte를 읽고, 단일 persistent writer가 두 batch를 저장한다.

| interval / Job 위상 간격 | wave p50 / p95 / max | interval 초과 wave | Job 0 E2E p50 / p95 | Job 1 E2E p50 / p95 |
|---|---:|---:|---:|---:|
| 50ms / 0ms (동시) | 8.115 / 112.481 / 129.220ms | 90/600 | - | - |
| 50ms / 5ms | 9.755 / 112.389 / 137.115ms | 85/600 | 4.196 / 57.269ms | 4.747 / 107.381ms |
| 10ms / 0ms (동시) | 7.985 / 11.536 / 141.806ms | 38/600 | 7.472 / 11.160ms | 4.601 / 9.911ms |
| 10ms / 5ms | 9.700 / 85.765 / 135.740ms | 231/600 | 3.832 / 33.805ms | 4.688 / 80.757ms |

`wave` 시간은 첫 번째 Job의 예정 시각부터 두 번째 Job 저장 완료까지이므로, 5ms 위상
분리 행에는 의도적인 5ms가 포함된다. 따라서 wave 수치만으로 Job별 overrun을 단정할 수는
없다. 그러나 각 Job의 자기 예정 시각부터 완료까지 측정한 E2E p95도 10ms/5ms 시험에서
각각 `33.805ms`, `80.757ms`로 동시 호출보다 나빠졌다. writer queue와 append+flush p95는
두 경우 모두 각각 `0.017ms`, `0.593ms` 이하였으므로 차이는 DBus 응답 지연에서 발생했다.

50ms에서는 p95 개선이 없고, 실제 검토 대상인 10ms에서는 결과가 명확히 나빠졌다. DBus
응답이 확률적으로 변한다는 점을 고려해도 이 표본만으로 위상 분리의 이득을 주장할 수 없다.
따라서 `schedule.phaseOffsetMs` 같은 제품 설정은 **추가하지 않는다**. 향후 PLC provider의
지연 원인이 해결된 뒤 같은 반복 측정을 통해 일관된 이득이 확인될 때만 재검토한다.

### 11.3 4,000건 구성 비교 (2026-09-03)

이번에는 실제 LS Go reader/writer 구조와 같은 persistent DBus connection 및 단일 native
writer로 다음 세 구성을 비교했다. 각 구성은 warm-up 10회 뒤 50ms interval에서 100 wave를
측정했다. `1 Job × 4 Call`은 같은 reader가 `%MB0`, `%MB1000`, `%MB2000`, `%MB3000`을
순서대로 읽고 4,000행을 한 writer batch로 넘긴다. 전용 TAG table은 각 실행에서 110,000 또는
440,000행 저장 확인 후 `DROP TABLE ... CASCADE`로 삭제됐다.

| 구성 | rows/wave | wave mean / p50 / p95 / max | 50ms 초과 wave | DBus read mean / p50 / p95 / max | writer 특성 |
|---|---:|---:|---:|---:|---|
| 1 Job × 1,000 × 1 Call | 1,000 | 21.890 / 5.605 / 105.286 / 116.258ms | 17/100 | 20.240 / 4.035 / 102.981 / 114.701ms | append+flush p50/p95 `0.784/1.356ms`, queue p95 `0.017ms` |
| 4 Jobs × 1,000 × 1 Call | 4,000 | 44.401 / 17.737 / 251.098 / 666.357ms | 9/100 | Job별 p50 `5.847~14.086ms`, max `202.488~424.798ms` | 보통 queue p50 `0.006~0.012ms`이나 DBus stall 뒤 최대 약 `650ms` 대기 |
| 1 Job × 1,000 × 4 Calls | 4,000 | 32.596 / 20.059 / 23.223 / 541.224ms | 5/100 | 4 Call 합계 24.294 / 13.610 / 15.460 / 535.198ms | 4,000행 append+flush p50/p95 `2.996/5.300ms`, queue p95 `0.015ms` |

4 Job 동시 호출은 중앙값 wave가 더 짧지만 DBus provider 지연이 겹칠 때 tail과 writer queue
대기가 크게 증가했다. 반대로 1 Job 안의 4 Call은 DBus를 순차 호출하므로 중앙값은 약 20ms지만
writer queue가 거의 없고 p95 wave가 23.223ms로 더 안정적이었다. 두 구성 모두 4,000건을 10ms
주기로 수집할 수는 없으며, 50ms에서도 DBus outlier 때문에 deadline 초과가 발생한다. 저장 경로의
중앙값은 여전히 병목이 아니며, 선택 기준은 DBus 호출 동시성에 따른 PLC provider tail behavior다.

### 11.4 정상 DBus 기준 +50% filter 비교 (2026-09-03)

각 physical `GetDeviceData` Call의 measured 100개 중 빠른 절반의 중앙값을 baseline으로 잡고,
`baseline × 1.5`보다 긴 Call이 하나라도 있으면 그 wave를 **제외**했다. 따라서 제외 집단은
50ms 이상의 명백한 stall만이 아니라 해당 구성의 정상 응답 범위에서 50%를 넘긴 중간 지연도 포함한다.
아래 normal/excluded 양쪽은 모두 별도 통계로 보존했다.

| 구성 | Call별 limit | normal / excluded wave | normal wave mean / p50 / p95 | excluded trigger Call 수·p50 / p95 / max |
|---|---:|---:|---:|---:|
| 1 Job × 1,000 × 1 Call | `3.598ms` | 50 / 50 | `4.301 / 4.346 / 5.203ms` | 50건, `5.098 / 100.219 / 111.542ms` |
| 4 Jobs × 1,000 × 1 Call | `6.546`, `10.761`, `14.893`, `6.063ms` | 3 / 97 | `15.899 / 15.999 / 16.060ms` | 192건, `13.162 / 106.509 / 417.556ms` |
| 1 Job × 1,000 × 4 Calls | `3.695`, `4.979`, `4.960`, `4.963ms` | 46 / 54 | `18.960 / 18.770 / 20.846ms` | 62건, `5.054 / 104.535 / 126.819ms` |

1 Job × 4 Call의 normal 집단은 DBus 합계 mean `12.539ms`, JSON parse mean `1.014ms`,
queue mean `0.012ms`, 4,000행 append+flush mean `3.542ms`였다. excluded 집단은 DBus 합계
mean `30.618ms`, E2E p95 `241.444ms`였고, append+flush에도 최고 `227.589ms` pause가 한 번
관측됐다. 따라서 DBus가 주된 제외 원인이지만 native append pause도 queue가 필요한 이유로 계속
남는다.

4 Job 동시 구성의 normal wave는 3회뿐이라 안정 성능 수치로 일반화할 수 없다. 동시 DBus 호출은
각 Job의 자체 baseline 범위 안에 동시에 들어오는 경우가 매우 드물었고, excluded wave의 p50도
`17.362ms`였다. 이 stricter filter에서도 4 Job 방식이 1 Job × 4 Call보다 일관된 정상 동작을
보이지 못했다.

### 11.5 CPU 부하 상관 측정 (2026-09-03)

"Neo DB와 collector가 동시에 CPU를 사용해 DBus가 느려지는가"를 확인하기 위해 위와 같은
100 wave/50ms 조건을 다시 실행했다. 각 wave 전후에 다음 CPU time을 함께 읽고, CPU time
증가량을 해당 wave의 실제 wall time으로 나누어 비율을 계산했다.

- `benchmark process`: collector Go process의 user + system CPU time (`getrusage`)
- `Neo container`: cgroup `cpuacct.usage` (collector와 Machbase Neo DB를 함께 포함)
- `PLC`: container에서 보이는 전체 `/proc/stat` CPU; idle+iowait은 busy에서 제외

개별 wave가 짧아 PLC 전체 CPU는 jiffy 단위로 양자화되므로, PLC 수치는 평균적인 경향만
사용한다. container/collector 수치는 나노초 CPU clock을 사용한다. CPU 비율은 wall time보다
CPU time이 더 늘 수 있으므로(여러 runnable thread 또는 짧은 표본) 100%를 넘을 수 있다.

| 구성 | normal / excluded wave | normal E2E p50 / p95 | excluded E2E p50 / p95 | process CPU mean (normal / excluded) | container CPU mean (normal / excluded) | PLC busy mean (normal / excluded) |
|---|---:|---:|---:|---:|---:|---:|
| 1 Job × 1,000 × 1 Call | 62 / 38 | 4.637 / 5.912ms | 6.870 / 124.110ms | 52.68 / 29.18% | 56.17 / 31.21% | 10.05 / 9.83% |
| 4 Jobs × 1,000 × 1 Call | 4 / 96 | 15.319 / 16.244ms | 17.447 / 172.283ms | 49.04 / 57.96% | 86.53 / 77.63% | 14.26 / 14.57% |
| 1 Job × 1,000 × 4 Calls | 48 / 52 | 18.594 / 21.148ms | 20.931 / 332.396ms | 43.55 / 43.38% | 63.99 / 69.53% | 12.13 / 13.88% |

`normal`/`excluded`의 기준은 11.4와 동일하다. 각 physical DBus Call의 빠른 절반 중앙값의
1.5배를 넘는 Call이 하나라도 있으면 해당 wave는 excluded다. 4 Job 동시 구성은 normal 표본이
4회뿐이므로 그 행의 normal 평균은 참고용으로만 본다.

이 표본에서 **DBus 지연 wave가 높은 CPU와 함께 나타난다는 일관된 증거는 없다.** 특히 단일
1,000건 Job은 excluded 구간에서 collector/Neo container CPU가 모두 절반 수준으로 내려갔다.
이는 collector가 DBus 응답을 기다리는 동안 CPU를 소비하지 않는 현상과 맞는다. 1 Job × 4 Call은
양 집단의 CPU 평균이 거의 같고, 4 Job 동시 구성도 excluded container CPU 평균이 normal보다
낮다. 따라서 현재 관측된 긴 DBus 응답을 단순한 collector/DB CPU 포화로 설명하기는 어렵다.

다만 이 결과는 "CPU가 절대 원인이 아니다"라는 증명은 아니다. container CPU에는 DB와
collector가 함께 포함되고, PLC 전체 CPU에는 다른 workload도 포함된다. 다음 단계에서 원인을
더 좁히려면 같은 PLC에서 (1) DB만 실행, (2) DBus read만 실행, (3) DBus read+append 실행을
각각 충분히 길게 반복해 CPU/DBus latency 시계열을 비교해야 한다. 현재 패키지 설계 판단에는
DBus provider의 간헐적 blocking을 독립적인 outlier로 계속 취급하고, bounded queue와 skip
정책으로 DB write pause를 흡수하는 것이 적절하다.

### 11.6 Container 2 CPU quota 비교 (2026-09-03)

Docker `--cpus 2` (`cpu.cfs_period_us=100000`, `cpu.cfs_quota_us=200000`)로
`machbase-neo-test` 전체를 약 2 CPU로 제한한 뒤, 11.5와 동일한 warm-up 10회 + measured
100 wave/50ms 조건을 다시 실행했다. 이 quota에는 Machbase Neo DB, collector benchmark와
container 안에서 실행되는 DBus client가 함께 포함된다. 모든 전용 TAG table은 실행 뒤
drop됐고, 테스트가 끝난 뒤 quota는 다시 `-1`(무제한)로 원복했다.

| 구성 | 무제한 wave p50 / p95 / max | 2 CPU wave p50 / p95 / max | 무제한 normal p50 / p95 | 2 CPU normal p50 / p95 | 2 CPU 제외 wave |
|---|---:|---:|---:|---:|---:|
| 1 Job × 1,000 × 1 Call | 5.675 / 106.793 / 124.939ms | 5.698 / 106.494 / 125.888ms | 4.637 / 5.912ms | 4.620 / 5.946ms | 41/100 |
| 4 Jobs × 1,000 × 1 Call | 17.412 / 155.795 / 930.421ms | 17.425 / 158.760 / 927.120ms | 15.319 / 16.244ms | 15.872 / 16.140ms | 95/100 |
| 1 Job × 1,000 × 4 Calls | 19.825 / 244.191 / 422.581ms | 19.796 / 199.378 / 705.055ms | 18.594 / 21.148ms | 19.222 / 21.448ms | 35/100 |

2 CPU 결과에서 단일 1,000건의 normal collector/container CPU 평균은 각각
`53.41%/55.69%`이고, DBus 지연 제외 구간은 `30.63%/33.41%`였다. 4 Job과 4 Call의
정상 중앙 경로도 무제한 결과와 약 0.6ms 이내로 같았다. 즉 이 범위에서는 container를
8 CPU에서 2 CPU로 제한해도 정상 DBus read/parse/append 경로가 의미 있게 악화되지 않았고,
100~400ms DBus outlier와 드문 native append pause도 그대로 남았다.

따라서 이번 표본은 "현재 관측하는 DBus 지연의 주원인이 8 CPU를 모두 쓰는 Neo/collector
CPU 경쟁"이라는 가설을 지지하지 않는다. 다만 2 CPU는 아직 정상 처리 평균보다 여유가 있는
조건이며, 더 낮은 quota나 다른 PLC workload가 동시에 있는 조건에서는 별도 장시간 시험이
필요하다. 짧은 wave의 cgroup CPU 비율이 순간적으로 200%를 넘을 수 있는데, 이는 quota가
100ms period 단위로 적용되고 측정 window가 period 경계를 걸치기 때문이며 지속적인 2 CPU
초과 실행을 뜻하지 않는다.

## 11. PLC 개발 측 전달 질문

테스트 패키지와 이 결과를 전달할 때 다음을 함께 문의한다.

1. `GetDeviceData(1000, "%MB0")`가 약 50~129ms 동안 block되는 조건은 무엇인가?
2. PLC scan cycle, device lock 또는 DBus service 내부 mutex와 연관되는가?
3. `DataCount=1000`일 때 공식적으로 보장하는 최대 호출 주기는 얼마인가?
4. 호출 시점의 snapshot을 non-blocking으로 반환하거나 내부 cache를 읽는 방법이 있는가?
5. 반환 JSON의 `time-stamp-us`는 어느 시점의 값이며, 지연 호출에서도 실제 PLC sample
   시각으로 사용할 수 있는가?
6. 10ms sample을 PLC 내부에서 누적해 batch로 반환하는 API가 가능한가?

## 12. 테스트 패키지 전달 체크리스트

- [ ] 전달한 LS package version/commit 기록
- [ ] PLC와 Neo version 기록
- [ ] Job 설정의 `intervalMs`, `DataCount`, `DeviceString` 첨부
- [ ] native connection/appender가 Job 동안 유지되는지 확인
- [ ] cycle duration과 DBus call duration을 분리한 별도 계측 결과 첨부
- [x] overrun policy는 always `skip`으로 고정
- [ ] overrun count와 마지막 발생 시각 checkpoint/log 발췌 첨부
- [ ] 동일 조건으로 최소 10초 이상 반복
- [ ] PLC 개발 측에 장시간 DBus 응답 표본과 질문 목록 전달
- [ ] 테스트 종료 후 임시 TAG table과 Job service 정리 확인

Frontend 구현과 화면 표시는 이 메모와 현재 Backend 계획의 범위에 포함하지 않는다.
