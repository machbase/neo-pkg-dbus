# LS Collector: Docker 실행 및 우선순위 확인

이 문서는 Linux/amd64 PLC에서 Collector의 FIFO/nice 정책을 적용하고 Timer
검증을 요청할 때 사용하는 실행 예시다. Machbase Neo 8.5.12와 PREEMPT_RT PLC에서
확인했다. 비RT Linux도 같은 설정 API를 사용하지만 측정 지터가 같다는 의미는 아니다.

2026-10-27 이후 테스트 PLC의 CPU 기준은 **6·7번**으로 한다. 아래 명령은 이 기준을
사용한다. 기존 CPU 4·5번 시험 결과는 당시 조건으로 보존하며, 6·7번에서 동일한
성능을 검증한 결과로 해석하지 않는다. 6·7번도 일부 PLC·DBUS 일반 스레드의 실행
허용 범위에 포함되므로 전용으로 격리된 CPU는 아니다.

## 필요한 설정

```text
--cap-add SYS_NICE
--cpuset-cpus 6,7
```

- `SYS_NICE`: Collector가 Reader의 `SCHED_FIFO`와 일반 Collector thread의
  nice를 설정할 권한이다. `--privileged`는 필요하지 않다.
- `--cpuset-cpus`: 사용할 **호스트의 논리 CPU 번호**다. `6,7`은 테스트 PLC의
  예시이며 다른 장비에서는 사용할 수 있는 번호로 바꾼다. CPU 개수를 뜻하지 않는다.
- cpuset은 해당 CPU에서 실행할 수 있도록 범위를 제한한다. 다른 호스트 프로그램의
  접근까지 막는 전용 CPU 예약은 아니다.
- 이번 비교 시험에서는 `--cpus`, `--cpu-quota`를 함께 지정하지 않는다. CPU 번호
  2개로 범위를 제한하고 CFS quota에 의한 throttling 영향을 제외하기 위한 조건이다.
  CPU 총량 제한만 지정하면 Collector의 `conditional` 적용 조건을 충족하지 않는다.

기존 컨테이너에 `docker restart`만 해서는 `SYS_NICE`가 추가되지 않는다.
실행 구성을 바꿔 컨테이너를 다시 생성해야 한다.

## 기존 설치를 유지할 때

먼저 현재 이미지, 명령, 환경변수, 포트와 mount를 기록한다.

```bash
docker inspect machbase-neo-test
```

DB의 `/data`, 패키지·사용자 파일의 `/file`, `/backups`뿐 아니라 Neo의 사용자 설정
경로도 유지한다. 이 시험 이미지에서는 `/root/.config/machbase`에 인증서와 서비스
등록 정보가 있었다. 기존에 volume으로 연결하지 않았다면 Neo를 중지한 뒤 복사한다.

```bash
docker stop --time 30 machbase-neo-test
mkdir -p ./neo-config
docker cp machbase-neo-test:/root/.config/machbase/. ./neo-config/
```

기존 `/data`, `/file`, `/backups`가 Docker volume이면 **그 volume 이름을 그대로
재사용**한다. 아래의 디렉터리 예시에 임의로 바꾸면 기존 데이터가 사라진 것처럼 보일
수 있다. 이미지 이름·버전, TZ 등 환경변수와 기존 포트도 유지한다. 설정 디렉터리에는
개인 키가 포함될 수 있으므로 전달용 자료에 넣지 않는다.

검증 전에는 이전 컨테이너를 삭제하지 않고 중지·이름 변경해 복구용으로 보관할 수 있다.
같은 데이터 volume을 사용하는 이전·새 Neo를 동시에 실행하지 않는다.

## 실행 명령 예시

아래는 host 디렉터리를 사용하는 배치 예시다. 디렉터리와 이미지를 실제 설치에 맞춘다.
기존 volume 설치를 바꿀 때는 위 절차에 따라 기존 volume으로 치환한다.

```bash
HOST_IP=192.168.1.55
NEO_CPUS=6,7
IMAGE=machbase-neo-local:8.5.12-pkg
NEO_ROOT="$(pwd)"

mkdir -p "$NEO_ROOT/neo-data" "$NEO_ROOT/neo-file/public" \
  "$NEO_ROOT/neo-backups" "$NEO_ROOT/neo-config"

docker run -d \
  --name machbase-neo-test \
  --restart=no \
  --cap-add SYS_NICE \
  --cpuset-cpus "$NEO_CPUS" \
  -p "${HOST_IP}:5652-5654:5652-5654" \
  -v "$NEO_ROOT/neo-data:/data" \
  -v "$NEO_ROOT/neo-file:/file" \
  -v "$NEO_ROOT/neo-file/public:/opt/public" \
  -v "$NEO_ROOT/neo-backups:/backups" \
  -v "$NEO_ROOT/neo-config:/root/.config/machbase" \
  -v /run/dbus/system_bus_socket:/run/dbus/system_bus_socket \
  -e TZ=KST-9 \
  --entrypoint /opt/machbase-neo \
  "$IMAGE" serve \
  --host 0.0.0.0 \
  --data /data \
  --file /file \
  --backup-dir /backups \
  --experiment=true
```

`/opt/public`에는 `/file/public`과 같은 패키지 파일이 보여야 한다. Neo 실행 파일과
`--file` 경로가 다른 이 배치에서 외부 실행 파일을 찾는 데 필요한 경로 대응이다.
위 예시의 포트 범위는 시험 PLC의 공개 포트를 유지한 것이다.

`--restart=no`는 시험 중 프로세스 종료가 자동 재시작에 가려지지 않도록 한 조건이다.
운영 배치의 restart 정책은 운영 기준에 맞춘다. TZ와 zoneinfo mount도 기존 장비의
구성을 유지한다. 위 TZ 값은 이 시험 PLC의 기존 값이다.

## Collector 내부 설정

`cgi-bin/conf.d/settings.json`의 `ls` 아래에 다음 설정이 있다.

```json
"scheduler": {
  "mode": "conditional",
  "fifoPriority": 50,
  "nice": -10,
  "gomaxprocs": 0
}
```

변경 뒤 **패키지의 Collector 서비스**를 중지·시작한다. Job 중지·시작만으로는 적용되지
않는다. `go-collector.json`은 서비스 시작 때 생성되는 snapshot이므로 직접 수정하지 않는다.
각 항목의 범위와 `off`/`conditional`/`force` 차이는
[Collector README](../collector-go/README.md#linux-scheduling-ls-internal-settings)를 참조한다.

## 실제 적용 확인

```bash
docker inspect machbase-neo-test \
  --format '{{json .HostConfig.CapAdd}} {{.HostConfig.CpusetCpus}} {{.HostConfig.Privileged}}'

docker exec machbase-neo-test \
  tail -n 5 /opt/public/neo-pkg-dbus/logs/_collector.log
```

시작 로그에서 아래 값들을 확인한다. CPU mask의 `6-7`과 `6,7`은 같은 범위다.

```text
mode=conditional enabled=true
cpus="6-7" cpuset="6-7"
requestedFIFO=50 requestedNice=-10 appliedNice=-10 gomaxprocs=2
```

Job 시작 로그에는 Reader의 실제 OS thread ID, FIFO priority와 nice가 기록된다.
`ps -eLo pid,tid,cls,rtprio,ni,psr,comm`을 지원하는 이미지라면 다음으로 함께 확인한다.

```bash
docker exec machbase-neo-test ps -eLo pid,tid,cls,rtprio,ni,psr,comm
```

Reader는 `CLS=FF`, `RTPRIO=50`이고 나머지 일반 Collector thread는 `NI=-10`이어야 한다.
`ps`는 FIFO thread의 NI를 `-`로 표시할 수 있으므로 해당 thread의 nice는 Job 로그의
실제 읽기 검증 결과로 확인한다. Neo의 우선순위 자체는 변경하지 않는다.

`enabled=false`, 권한 오류 또는 Reader 적용 실패가 나오면 시험 조건이 성립하지 않은
것이다. 이 PLC에서는 위 두 Docker 옵션만으로 적용됐지만, 다른 커널/cgroup 환경은
Docker daemon의 RT 지원·RT 실행 예산도 확인해야 할 수 있다.

시험 자료에는 CPU 모델/개수, RT 커널 여부, Neo 버전, Docker 옵션, 적용 로그,
Job의 Timer 방식·주기·Tag 수, 시험 시간과 retention 조건을 함께 기록한다.
자원 사용량이나 CPU 부하가 다른 장비에 동일한 지터 상한을 보장하는 설정은 아니다.

공식 참고:
[Docker CPU/RT resource constraints](https://docs.docker.com/engine/containers/resource_constraints/),
[Docker runtime capabilities](https://docs.docker.com/engine/containers/run/#runtime-privilege-and-linux-capabilities).
