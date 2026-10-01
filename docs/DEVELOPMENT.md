# neo-pkg-dbus Development Guide

This document retains the development and operational material formerly kept in the root README. The root README is intentionally short because Machbase Neo displays it as the package description.

## Requirements and layout

The minimum supported Machbase Neo version is `8.5.8`; the Job configuration schema is `schemaVersion: 1`.

| Path | Purpose |
|---|---|
| `products/generic/` | Generic product frontend and backend source |
| `products/ls/` | LS product frontend, backend, and interface source |
| `cgi-bin/product/` | Backend selected by the current product build |
| `cgi-bin/conf.d/` | Package settings, Jobs, interfaces, and database servers |
| `cgi-bin/logs/` | Rotated per-Job logs |
| `collector-go/` | LS native collector source and build script |

Database passwords remain in database-server configuration only. They must never be exposed through Job configuration, APIs, or logs.

The default logging policy keeps a 1 MiB active log and three retained rotated files. Normal operation records start, stop, and configuration events. Repeated failures and scheduled-cycle skips are reduced to periodic summaries to protect PLC storage.

## Build and test

```bash
cd frontend
npm ci
npm run test:layout
cd ..
node --test cgi-bin/tests/*.test.cjs
npm run build
```

The default build produces the generic package. Build the Linux PLC target with:

```bash
npm run build -- --target=ls
```

The LS build cross-builds the native collector for `linux/amd64` and includes it as `cgi-bin/bin/neo-dbus-collector`. The package lifecycle normalizes the executable mode to `0755`, including after a ZIP extraction that removed executable bits.

## LS collection behavior

The LS collector has one Go service, one native writer, and one reader goroutine per active Job. A reader uses the PLC timestamp returned by DBus, decodes and transforms typed rows, then puts them on the shared bounded writer queue without waiting for a database flush. Queue rows carry a daemon-stable numeric TAG registry index rather than a repeated TAG string; the channel allocates only its 512 pointer slots up front and batch payloads are allocated only by completed reads. The writer keeps one native Neo appender open for the shared Database profile; it is the only component which appends data. It also completes ordinary batches directly after Flush instead of creating one waiting goroutine per collection cycle; at short intervals this keeps goroutine and stack usage bounded by the daemon structure rather than by the number of batches awaiting the 1-second Flush. Its internal defaults are a 512-batch queue, an 8,192-row native batch threshold, and a 1-second forced flush. They live under `settings.json.ls.writer` for deployment tuning only and are not frontend controls. A controlled logical Job or package stop drains queued rows and requests a final flush; an unexpected process/power loss can lose rows still buffered since the last flush.

PLC performance diagnostics are internal settings under `settings.json.ls.performance` and default to enabled. Each Job writes one microsecond summary with `job=<name>` per 1,000 read attempts, and the shared writer writes a `scope=shared` summary without a Job name per 30 seconds to each active Job log. Those defaults remain 1,000 and 30,000ms; their enforced minimums are 500 and 10,000ms. The Job summary includes DBus avg/p99/max, parse avg/max, reader-total p99/max, total skip count, scheduler-overrun count, queue-full skip count, and error count. The writer summary includes maximum queued batches and configured capacity, append/flush busy ratio, append batch/row counts, append service throughput, append avg/p99/max, flush max, and enqueue-to-successful-flush p99/max. Append and queue-to-durable samples are each capped at 4,096 entries; no per-cycle performance records are written. The common log prefix supplies the record timestamp.

LS has one shared Database Server profile. The profile's server connection, Default Table and column mapping apply to every LS Job. The LS UI does not add, delete, or switch Database Server entries; edit the existing profile instead. Editing it while logical Jobs are active asks for confirmation, atomically refreshes the small collector policy/secret files, and reloads those Jobs. If the package service itself is stopped, the new settings are saved for the next start and the service is not started implicitly.

The full LS Job remains in `cgi-bin/conf.d/jobs/<name>.json`. A small `cgi-bin/conf.d/job-index/<name>.json` is written last and is the registration marker used by list, health, monitoring, lifecycle and reference checks. Updates keep the previous index until the new canonical document has been atomically committed, then atomically replace the index. If that final index write fails, the Job remains visible through its previous marker and repeating the same save repairs the stale index without incrementing the canonical revision again. Monitoring uses `/job/status`; only Edit and Tag hierarchy operations read the full Job. There is intentionally no migration for pre-index Jobs during this development phase: remove old Jobs and recreate them after installing this build. A direct attempt to read one is reported as `This Job configuration cannot be read. Recreate the Job before continuing.`

`overrunCount` includes both a reader cycle skipped because that Job is busy and a batch rejected because the shared queue is full. `queueSkipped` is its queue-full subset and is reported beside the total when non-zero. Both counters are runtime-only and reset on logical Job start or when the monitoring clear action is used.

By default the package reads `ls.plc.program.GetTaskCycleInfo` with `TaskNumber=0` when an LS Job is created or saved. A successful `period-ms` result becomes the interval step. The interval editor rounds a typed value upward to that step; if the call is disabled or unavailable the step is `1ms`. Existing Jobs are not invalidated by a later policy change.

Each LS Tag has a type conversion followed by a `signed` option and then bias/multiplier calculation. `%MB/%MW/%MD/%ML` default to `BYTE2INT`, `WORD2INT`, `DWORD2INT`, and `LWORD2INT`; `signed:true` applies the matching 8/16/32/64-bit two's-complement interpretation before the calculation. `%MD` additionally supports `DWORD2REAL` and `%ML` supports `LWORD2LREAL`, which reinterpret the returned unsigned bit pattern as IEEE-754 `float32`/`float64`; Signed is disabled for these conversions. `%MX` values remain bits and use neither setting. Automatically created tables use DOUBLE; create an appropriate integer VALUE column yourself when exact integer storage, especially 64-bit `%ML`, is required.

Machbase Appender reserves one value of each numeric type as its NULL sentinel.
If a PLC value can equal one of the values below, create the table with a wider
VALUE column type. The collector passes every DBUS numeric result as data and
does not reinterpret it as NULL. Machbase Appender itself cannot distinguish an
ordinary value equal to its reserved NULL value, so that value can be treated as
NULL and a TAG sample with no non-NULL value column may produce no data row.

| VALUE type | Reserved value |
| --- | ---: |
| SHORT | -32768 |
| USHORT | 65535 |
| INTEGER | -2147483648 |
| UINTEGER | 4294967295 |
| LONG | -9223372036854775808 |
| ULONG | 18446744073709551615 |
| FLOAT | 3.402823466e+38 |
| DOUBLE | 1.7976931348623158e+308 |

For example, use INTEGER instead of SHORT/USHORT and LONG instead of
INTEGER/UINTEGER when the full source range is required. DOUBLE can represent a
wider magnitude but may not preserve every 64-bit integer exactly; choose the
table schema according to whether range or exact integer precision is required.
LONG or DOUBLE is generally recommended for a user-created VALUE column, while
their own reserved NULL values remain unavailable as ordinary data.

## Package lifecycle

When Neo installs a package through its package UI, it invokes the package lifecycle scripts automatically. A manually extracted package must run the lifecycle once in Neo JSH before opening the page:

```text
pkg run -C /work/public/neo-pkg-dbus install
pkg run -C /work/public/neo-pkg-dbus start
```

To stop or remove a manually installed package:

```text
pkg run -C /work/public/neo-pkg-dbus stop
pkg run -C /work/public/neo-pkg-dbus uninstall
```

The package page is available at `http://<neo-host>:5654/public/neo-pkg-dbus`.

## PLC Docker `/work` operation-lock compatibility

Machbase Neo 8.5.11 on the LS development PLC exposed a Docker-only directory-rename problem through JSH `/work`. An existing source directory could remain in place while `fs.renameSync()` reported `ENOENT`. This affected both the Neo ZIP installer's final staging move and the package's former directory-based operation-lock release. The Neo installer fix is complete but, at the time of this document, is not yet in a released Neo version. This is specific to Neo's Docker/JSH path handling and is not a general Docker rename limitation.

The package no longer uses a directory as its canonical operation lock. A lock such as `.job-operation-locks/job-1.lock` is now a `0600` JSON **file** containing `token`, `pid`, `acquiredAt`, and `heartbeatAt`. Acquisition uses `openSync(path, "wx")`, backed by `O_CREAT | O_EXCL`, so exactly one CGI process can create it. Heartbeat updates atomically replace this file through file rename, and release re-reads the token and unlinks only the same owner's file. No operation-lock path uses directory rename.

The PLC test also found that Neo JSH 8.5.11 wraps an `O_EXCL` collision as `ENOENT` instead of `EEXIST`. The lock implementation therefore checks the actual path after a failed exclusive open. An existing path means contention and returns `JOB_CONFLICT`; the error code by itself is never interpreted as proof that the lock is absent.

A short-lived `<lock>.reclaim` directory serializes the acquire/stale-recovery critical section, but directory creation itself is not treated as a lock: Neo JSH's `mkdirSync` can succeed when the directory already exists. Contenders instead acquire its fixed `owner.json` file with the same atomic `wx` operation. Stale takeover renames only that **file** to a token-specific claim file, and release removes the owned file followed by best-effort `rmdir`; no directory is renamed. The guard is normally absent while the Job mutation itself runs. A guard directory left by a cleanup error may temporarily block another mutation, but it cannot invalidate or expose the active canonical lock and is reclaimed through the same lease rule. The canonical file still has a 30-second lease. A valid lock is reclaimed only after lease expiry and confirmed owner-PID termination. A fresh, live, ambiguous, or uncertain lock fails closed. A malformed file uses its mtime and can be removed only after the lease. Directory locks left by an older package version follow the same lease/PID checks and are converted to the file format on the next valid recovery.

The operation lock protects rare mutation overlap rather than high request throughput: Save versus Start/Stop, duplicate submission, direct API retry, or package stop/uninstall versus a Job mutation. GET, monitoring, DataViewer, and log reads do not acquire it.

## LS Appender readiness

The LS daemon accepts a logical Job Start after validating its config, persisting desired-active state, and publishing runtime `starting`. The potentially long readiness work then runs asynchronously, so the control request does not wait for thousands of TAG registrations. The reader scheduler still does not start until the shared writer confirms `Connect`, table-column inspection, and batch-policy setup and TAG preparation completes. A preparation failure removes desired-active state and publishes runtime `failed` with its concrete reason.

`AppendOpen` does not include all one-time database work: the first data batch automatically registering thousands of new TAG names can remain expensive after `Connect` returns. During asynchronous preparation the collector therefore reads the configured table's TAG metadata once and explicitly registers only missing names with `INSERT INTO <table> METADATA (<primary>) VALUES (?)`. Registration is serialized per `(server, table)`, is idempotent for existing names, and uses a separate SQL connection so it cannot block append/flush work for already-running Jobs. It must still finish before this Job's reader starts. Stop during `starting` cancels the preparation context.

The first epoch-aligned cycle is additionally appended and flushed synchronously before the reader enables its normal overlapping schedule. It is real collected data, not a dummy row. A failed first read or write is retried on the next aligned boundary while later cycles remain closed. This prevents both TAG registration and first-flush work from filling the bounded queue; queue-full events after this priming cycle remain genuine writer-pressure diagnostics and are not hidden.

Until a Neo release containing the completed ZIP-installer fix is deployed, an affected PLC must extract the package to exactly `/work/public/neo-pkg-dbus` and run the documented lifecycle commands. Once a fixed Neo release is installed, the normal ZIP installation path can be used.

For diagnosis, the canonical owner JSON is the lock file itself:

```text
<package>/cgi-bin/conf.d/.job-operation-locks/<job>.lock
<package>/cgi-bin/conf.d/.interface-mutation-readers/<interface-key>--<job>.lock
```

Record the token, `pid`, `acquiredAt`, and `heartbeatAt`, then check the PID and lease. Never remove a fresh lock or one whose process may still be alive; normal operation should use guarded automatic recovery.

## API conventions

The API base path is `/public/neo-pkg-dbus/cgi-bin/api`. Successful responses use `{"ok":true,"data":{}}`; errors use `{"ok":false,"code":"...","reason":"...","details":{}}`.

Important endpoints include `/settings`, `/job`, `/job/status`, `/job/start`, `/job/stop`, `/job/last-run`, `/job/overrun/reset`, `/job/log`, `/dbus/call`, `/db/*`, and `/log/*`.

For full behavioral and UI contracts, consult `docs/specs/DBUS_SDD.md`, `docs/specs/FE_DESIGN.md`, and `docs/specs/BE_DESIGN.md`.
