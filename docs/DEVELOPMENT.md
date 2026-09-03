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

The LS collector has one Go service, one native writer, and one reader goroutine per active Job. A reader uses the PLC timestamp returned by DBus, decodes and transforms typed rows, then puts them on the shared bounded writer queue without waiting for a database flush. The writer keeps one native Neo appender open for the shared Database profile; it is the only component which appends data. Its internal defaults are a 64-batch queue, a 1,024-row native batch threshold, and a 1-second forced flush. They live under `settings.json.ls.writer` for deployment tuning only and are not frontend controls. A controlled logical Job or package stop drains queued rows and requests a final flush; an unexpected process/power loss can lose rows still buffered since the last flush.

LS has one shared Database Server profile. The profile's server connection, Default Table and column mapping apply to every LS Job. The LS UI does not add, delete, or switch Database Server entries; edit the existing profile instead. Editing it while logical Jobs are active asks for confirmation, atomically replaces the collector snapshot, and reloads those Jobs. If the package service itself is stopped, the new snapshot is saved for the next start and the service is not started implicitly.

`overrunCount` includes both a reader cycle skipped because that Job is busy and a batch rejected because the shared queue is full. `queueSkipped` is its queue-full subset and is reported beside the total when non-zero. Both counters are runtime-only and reset on logical Job start or when the monitoring clear action is used.

By default the package reads `ls.plc.program.GetTaskCycleInfo` with `TaskNumber=0` when an LS Job is created or saved. A successful `period-ms` result becomes the interval step. The interval editor rounds a typed value upward to that step; if the call is disabled or unavailable the step is `1ms`. Existing Jobs are not invalidated by a later policy change.

Each LS Tag has a `signed` option (default `false`). It applies two's-complement conversion based on `%MB`, `%MW`, `%MD`, or `%ML` before bias/multiplier calculation. `%MX` values remain bits. Automatically created tables use DOUBLE; create an appropriate integer VALUE column yourself when exact integer storage, especially 64-bit `%ML`, is required.

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

## API conventions

The API base path is `/public/neo-pkg-dbus/cgi-bin/api`. Successful responses use `{"ok":true,"data":{}}`; errors use `{"ok":false,"code":"...","reason":"...","details":{}}`.

Important endpoints include `/settings`, `/job`, `/job/start`, `/job/stop`, `/job/last-run`, `/job/overrun/reset`, `/job/log`, `/dbus/call`, `/db/*`, and `/log/*`.

For full behavioral and UI contracts, consult `docs/specs/DBUS_SDD.md`, `docs/specs/FE_DESIGN.md`, and `docs/specs/BE_DESIGN.md`.
