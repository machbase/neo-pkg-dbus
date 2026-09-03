# neo-pkg-dbus LS Integration Test Plan

## Scope and execution split

This plan covers the LS build on the PLC. Package installation, upgrade, and uninstall must be verified separately by the user in the real GitHub ZIP delivery environment. All other functional, API, UI, performance, lifecycle, and long-running tests are PLC test items for the package team.

Record the Neo version, Docker CPU quota, free disk space, `/tmp` usage, DBus interface state, test Job names, and table names before each run. Stop Jobs at the end of a run but retain tables, logs, checkpoints, and result data. Remove only temporary upload files and test processes.

## 1. Service and Job lifecycle

- Start Neo and verify that the package service starts once and that the Go collector starts only active Jobs.
- Verify that Job Start/Stop controls a reader goroutine without stopping the shared package service.
- Stop every Job and confirm that health, UI, and the actual process state all report `stopped` consistently.
- Verify that Job Start resets overrun statistics.
- Force a Neo container stop/start and verify that the JSH service and its Go child terminate, no orphan collector remains, and only active Jobs resume.
- Edit the database profile while the package service is stopped. Confirm that the snapshot is saved without implicitly starting the service.

## 2. Shared database profile and table policy

- Test a database connection with no password, invalid credentials, and valid credentials. The UI must show an input-error toast, failure toast, and success toast respectively.
- Verify that LS does not permit adding, deleting, or switching database profiles and that all Jobs use the one shared profile/table mapping.
- Edit the profile while Jobs are active, accept the restart confirmation, and verify that every affected Job reloads the new mapping.
- Verify automatic DOUBLE VALUE table creation and normal writes.
- With a manually created integer VALUE column, verify integer writes and a clear save failure when a calculation produces a fractional value.
- For exact `%ML` storage, create a LONG INTEGER VALUE column manually and verify the documented precision policy.

## 3. Tag decoding and calculation

For each type below, compare unsigned default handling with `signed: true`:

| Type | Boundary values |
| --- | --- |
| `%MX` | `0`, `1`; signed must not change bit handling |
| `%MB` | `0x7F`, `0x80`, `0xFF` -> `127`, `-128`, `-1` |
| `%MW` | `0x7FFF`, `0x8000`, `0xFFFF` -> `32767`, `-32768`, `-1` |
| `%MD` | positive/negative signed boundaries |
| `%ML` | feasible signed boundaries and precision policy |

- Verify that two's-complement conversion occurs before bias/multiplier calculation.
- Verify calculation order, identity calculation (`bias=0`, `multiplier=1`), and independent settings for mixed Tags in a Call.
- Verify that CSV import/export preserves `signed`.

## 4. Interval, PLC task cycle, and fixed-rate scheduling

- When `GetTaskCycleInfo(0)` succeeds, verify use of `period-ms` as the interval step and a default interval equal to the nearest cycle multiple at or above 10ms.
- Verify typed interval rounding to a valid multiple (for example, 10ms to 12ms for a 4ms cycle) and minimum clamping after a cycle change.
- When the task-cycle call fails or the policy is disabled, verify a 1ms step and unrestricted interval entry.
- Verify fixed-rate scheduling against wall-clock boundaries: a 10-second Job runs at `:00`, `:10`, `:20`, rather than waiting an interval after completion.
- Verify two different Job intervals and a deliberate 5ms phase offset.

## 5. Overrun and bounded queue

- Set an interval shorter than the read duration. Verify that the next reader cycle is skipped while the active read completes, with `overrunCount` and `lastOverrunAt` updated.
- Saturate the writer queue. Verify queue-full rejection and that `queueSkipped` remains the queue-full subset of the total skip count.
- Verify counter reset on Job Start and Monitoring clear.
- Verify Monitoring presents total skipped cycles, queue-full subset when non-zero, last skipped time, strong warning styling, and a clear action.
- Verify the removed duplicate lower skipped-cycles panel does not return.

## 6. Persistent writer, append, and flush

- Verify that one shared native writer/appender exists and readers do not wait for database flush after putting a batch on the queue.
- Compare `flushMaxRows=1024`, `flushIntervalMs=1000` with lower row thresholds and longer forced-flush intervals.
- Verify that low-rate input becomes visible after forced flush and high-rate input flushes at the row threshold.
- On logical Job stop and package stop, verify queue drain, final flush, and persistence of rows accepted before the stop.
- On unexpected container/Neo termination, record the possible loss window since the most recent flush.

## 7. Performance and CPU measurements

For every case, record read, parse, queue, write, and flush timing; DBus-delay excluded statistics; excluded count; queue/read skips; average/maximum CPU; and database backlog.

- 1,000 bytes x 1 Job
- 1,000 bytes x 4 Jobs (4,000 bytes total)
- 1 Job with four 1,000-byte Calls (4,000 bytes total)
- 500 bytes x 2 Jobs
- 250 bytes x 4 Jobs
- Two Jobs with different starting memory addresses
- Default Docker CPU allocation and a 2-CPU quota

Classify responses more than approximately 50% slower than the normal DBus baseline as DBus-delay samples and retain their count/statistics separately. Record CPU during those samples to distinguish PLC/database load from DBus response delays.

## 8. CGI/API error behavior

- Exercise `/health`, `/job/list`, `/job`, `/job/last-run`, `/job/start`, `/job/stop`, `/job/overrun/reset`, `/job/log`, `/dbus/call`, `/db/*`, and `/log/*` for valid and invalid input.
- A missing Job log may be 404, but must not leave a persistent error in either UI panel; show a toast instead.
- Verify database, validation, and service failures use the standard API error response shape.
- Verify CGI failure under low `/tmp` or container filesystem space still has a valid CGI response/header and produces a diagnosable error.

## 9. Frontend regression

- On first entry, verify the first selected Job is also displayed in the right panel; selecting another Job must load its detail and last-run information.
- At narrow sidebar widths, verify the Jobs refresh control and Job Start/Stop switches remain visible with balanced side margins.
- Verify Monitoring values, log-level selector, and skipped-cycle clear action.
- Verify log file selection loads content by default; CONTENT/ALL/TAIL have visible selection state and English tooltips; return to Job uses the standard back navigation.
- Verify log-level changes are recorded in the log and rotation text is compact (size and retained count only).
- Verify Edit Database Server uses a 540px dialog height with body-only scroll, and correct password/error/success toast behavior.

## 10. Logging and PLC storage

- Verify normal logs contain only required lifecycle/configuration events.
- Verify repeated failures and cycle skips are summarized rather than logged per occurrence.
- Verify 1 MiB active log, three retained rotations, purge behavior, and useful correlation of collector and JSH lifecycle logs.
- During long runs, record package-log and container-disk growth.

## 11. Long-running stability

Run representative configurations for multiple hours:

- 1,000-byte Job x 1
- 500-byte Job x 2
- 250-byte Job x 4
- One Job with four 1,000-byte Calls

For each configuration, stop/start Neo and repeat the lifecycle checks. Leave the final Jobs stopped while retaining test data, logs, checkpoints, and the measurement record.

## User-operated package delivery verification

The package team should ask the delivery user to perform these GitHub ZIP tests on a clean target:

1. Download the LS build ZIP from GitHub and extract it under `public/neo-pkg-dbus`.
2. Install/start through Neo Package UI, or run:

   ```text
   pkg run -C /work/public/neo-pkg-dbus install
   pkg run -C /work/public/neo-pkg-dbus start
   ```

3. Confirm that ZIP extraction removing executable bits is corrected and `neo-dbus-collector` runs with mode `0755`.
4. Confirm package UI/public URL access, then test stop/uninstall and an upgrade from the prior package.
5. Confirm no collector remains after stop/uninstall and that configuration, logs, and Job state follow the intended upgrade/removal policy.

