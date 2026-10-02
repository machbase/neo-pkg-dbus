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

Each Job prepares one fixed row layout and starts with four reusable full-cycle
buffers. The idle cache can grow to 32 during writer stalls; further buffers are
temporary. A reader reserves bounded-queue capacity before DBus work, fills all
Call segments directly in one leased buffer, and transfers ownership without a
row copy. The writer returns the queue reservation when dequeuing and clears and
returns the buffer immediately after synchronous native append, so the periodic
Flush wait retains only completion metadata. Error, cancellation, and Stop paths
release both resources exactly once; stopping a Job drains its work and disposes
its pool.
