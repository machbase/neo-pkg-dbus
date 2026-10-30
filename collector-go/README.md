# LS Go collector

`neo-dbus-collector` is only staged by `npm run build -- --target=ls`.  It is
not part of the generic package.

Build the Linux/amd64 executable:

```bash
./build.sh
```

The LS build uses CGo and statically links the Machbase C SDK Appender into the
collector. Set `MACHBASE_HOME` to a Linux/amd64 SDK directory containing
`include/machbase_sqlcli.h` and `lib/libmachbasecli.a`. In this development
workspace the build script also detects `../dbms-nfx/machbase_home` relative to
the repository automatically.

The production build selects the `machcli` build tag. Ordinary `go test ./...`
does not require the C SDK and retains the pure-Go Appender backend for unit
tests. The CGo hot path crosses into C once per logical row batch; TAG names are
registered and cached during Job preparation. Queue rows carry stable numeric
TAG indexes, so names are neither copied into every row nor looked up by string
on every cycle. The CGo backend ignores priming and Job-stop forced-Flush requests and
uses only the shared writer's configured periodic Flush (one second by default).
Table switches and collector shutdown still make pending rows durable through
`SQLAppendClose`. The pure-Go backend keeps its existing forced-Flush behavior
so it can be selected again without restoring removed code.

The daemon reads the JSH-created `cgi-bin/conf.d/go-collector.json` and the
0600 `go-collector-secrets.json`.  JSH starts one daemon service and invokes
the executable with `--control start|stop|reload <job-name>` for logical Job
control.  The daemon maintains a single native writer and an epoch-aligned,
fixed-rate reader per running Job.

Each LS Job stores `dbusDestination` and `dbusInterfacePrefix` independently.
Both default to `ls.plc` for existing Jobs. The destination accepts any valid
DBus bus name up to 255 ASCII bytes; the Interface prefix accepts a valid DBus
name up to 247 ASCII bytes. The first
selects the system-bus service; the second selects `<prefix>.device.GetDeviceData`
and `<prefix>.program.GetTaskCycleInfo`. Job save, Test Call and the reader use
the same pair. Stop, save and restart the Job after changing either value.
The tested PLC uses `high.ls.plc` as the service with `ls.plc` as the interface
prefix. Object paths remain `/ls/plc/device` and `/ls/plc/program`.

Job performance summaries transfer ownership of the completed sample window to
the existing logging worker. Percentile calculation, formatting and file I/O
run there, not in the reader. The next window uses independent sample arrays.
The 64-record queue remains bounded and lossless; a full queue can still apply
backpressure during a prolonged logging stall. Stop/shutdown drain queued
summaries before returning. Serial timer accounting is described below.
Reader summaries include `min/p99/max`, with the DBus duration from the same cycle
attached to both extrema, e.g. `readerTotalUs[min=1100(dbus=1000) p99=1365 max=1743(dbus=1200)]`.
All values are microseconds. A multi-Call cycle uses its accumulated DBus duration.
Microsecond ties retain the first cycle; unmeasured DBus (including TEST input) is
`n/a`, while a measured zero is `0`. Empty reader windows keep zero extrema with
`dbus=n/a`. Extrema use fixed-size metadata rather than another per-cycle array.
`readerTotalUs` measures reader entry through queue handoff, including queue-slot,
buffer and DBus connection preparation, but excluding later bookkeeping and
OS scheduling time; do not
attribute a skip to the timer solely from a small `readerTotalUs.max`.

Each Job prepares one fixed row layout and starts with four reusable full-cycle
buffers. The idle cache can grow to 32 during writer stalls; further buffers are
temporary. A reader reserves bounded-queue capacity before DBus work, fills all
Call segments directly in one leased buffer, and transfers ownership without a
row copy. The writer returns the queue reservation when dequeuing and clears and
returns the buffer immediately after synchronous native append, so the periodic
Flush wait retains only completion metadata. Error, cancellation, and Stop paths
release both resources exactly once; stopping a Job drains its work and disposes
its pool.

## Linux scheduling (LS internal settings)

For a shareable Docker run example, preserving an existing installation, and
checking the applied OS priorities, see
[LS Docker scheduling guide](../docs/LS_DOCKER_SCHEDULING.md).

Edit `cgi-bin/conf.d/settings.json`, then stop and start the **collector service**
(stopping a logical Job alone does not apply changes). The JSH launcher refreshes
`go-collector.json` at each service start. That file is a generated snapshot;
edit `settings.json`, not the snapshot. There is no frontend setting.

```json
"scheduler": {
  "mode": "conditional",
  "fifoPriority": 50,
  "nice": -10,
  "gomaxprocs": 0
}
```

This object belongs under `ls` alongside `timer` and `writer`.

| Key | Range / behavior |
| --- | --- |
| `mode` | `off`: leave inherited OS priorities; `conditional` (default): apply only in confirmed Docker with a restricted cgroup cpuset; `force`: attempt regardless of environment and fail startup if application fails. |
| `fifoPriority` | Integer 0–99. 0 uses ordinary scheduling; 1–99 applies `SCHED_FIFO` to each Job's Timer/Reader OS thread. Higher values have higher FIFO priority. |
| `nice` | Integer −20–19 for Collector threads; lower values have higher ordinary scheduling priority. This does not change Neo's priority. |
| `gomaxprocs` | Integer 0–64. 0 preserves Go's runtime/environment default; a positive value sets Go execution parallelism. 64 is this package's operational cap, not a Go limit. This setting applies independently of `mode`. |

Out-of-range integers are clamped and the configured and applied values are
logged. Invalid modes or non-integer types are configuration errors.

Use Docker `--cpuset-cpus`, with CPU numbers chosen for the deployment, to
restrict eligible CPUs. CPU quota (`--cpus`) alone does not qualify. Detection
reads cgroup cpuset and process affinity; no Docker socket is required. An
inherited/empty mask, a full-host mask whose restriction cannot be established,
or unreadable cgroup information disables conditional application and is logged.
CPU numbers are never hardcoded in the collector. Restart after changing CPU or
scheduler settings.

Raising priorities normally requires Docker `--cap-add SYS_NICE` and compatible
host/cgroup RT permissions. In `conditional` mode an unavailable permission or
facility logs a reason and retains ordinary execution. `force` reports the
failure instead of silently continuing. A failure after a partially completed
bootstrap is fatal in either mode. The application APIs are the same on RT and
non-RT Linux; PREEMPT_RT detection is diagnostic only. These settings do not
guarantee a jitter bound or reserve a CPU exclusively for the reader.

Startup logs in `logs/_collector.log` record mode, decision, reason, observed
CPU mask, RT detection, actual nice and Go parallelism. Range corrections are
WARN entries. Each Job logs its actual FIFO policy/priority and OS thread ID
when applied. The collector starts its Go runtime at the selected nice value
using a same-PID exec; no external `nice` utility is required. Job exit restores
the Reader thread's original policy before returning it to Go.
Package Stop/restart signals the native child and lets its JSH launcher reap it
before controller shutdown (bounded to 15 seconds). This avoids orphan zombies
when Neo itself is Docker PID 1; a timeout logs a warning and proceeds with the
existing controller Stop path.

## Serial Timer/Reader and skip measurements

Both standard and absolute timer modes wait and execute the read/parse/enqueue
in the same Job goroutine. The shared Writer remains separate. Percentile and
file logging still run in the bounded logging worker, after data handoff.

Elapsed scheduled boundaries are counted when the serial timer advances to its
next future deadline. Missed cycles are not replayed. `overIntervalCount` counts
those skipped boundaries; Queue-full rejections are still separately counted
in `queueFullSkipCount`, and `skipCount` is their sum. Initial durable-priming
boundaries are excluded as before. Stop bounds skipped slots at the stop request
and drains already queued work. Start and monitoring Clear retain their reset
behavior.

`scheduleSamples[wake=... start=...]` counts actual timer returns and reader
entries, not bypassed slots. It therefore need not satisfy the old
`wake = start + skip` relationship. For a bypassed slot there was no timer wake:
the last-overrun detail shows `skippedTimerWakeLagUs=n/a` and a separate
`detectedLagUs`. Its reader durations and original timer/start lag refer to the
preceding completed read. Logger backpressure can contribute to missed slots;
it is not a DBus timing measurement.
