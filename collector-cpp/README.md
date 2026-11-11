# LS native C++ collector

The LS package builds this standalone Linux/amd64 daemon. JSH continues to own
package service management, Job/configuration APIs, validation, and frontend
integration. The previous implementation remains in `../collector-go/`.

## Build

Build on Linux/amd64 with GCC/G++ supporting C++17, the system libsystemd runtime,
and the Machbase CLI SDK. Set `MACHBASE_HOME` to the SDK directory containing
`include/machbase_sqlcli.h` and `lib/libmachbasecli.a`. This workspace also detects
`../../dbms-nfx/machbase_home` relative to this directory. No compiler is required
on the PLC: the LS package includes the executable with mode 0755.

```bash
MACHBASE_HOME=/path/to/machbase_home bash build.sh
# Build the complete deliverable from the repository root:
npm run build -- --target=ls
```

Output: `dist/linux-amd64/neo-dbus-collector`, staged as
`cgi-bin/bin/neo-dbus-collector`. The CLI SDK and C++ runtime are linked
statically; glibc and `libsystemd.so.0` remain runtime dependencies. The supported
PLC image must provide these libraries; check `ldd` when changing the image.
The tested baseline is the PLC's Ubuntu 22.04 image with Neo 8.5.12.

`bash test.sh` runs the unit, parser, pool, timer, scheduling-environment and
logging/statistics tests without a database. `bash test.sh asan` adds ASAN/UBSAN
and leak checking. `bash build.sh asan` builds the complete instrumented daemon
for private integration tests. Sanitizer runtimes are needed only by that build.
`bash build.sh testing` creates a separate executable with private fault/replay
hooks; it is never staged by the package build. The ordinary release binary has
neither those hooks nor their environment switches.

## Runtime and compatibility

```bash
neo-dbus-collector --root /physical/path/to/cgi-bin --parent-pid JSH_PID
neo-dbus-collector --root /physical/path/to/cgi-bin --control start job-1
```

The executable name, arguments, Unix socket, control commands, active-Job file,
Job/index documents, checkpoint fields and UTC timestamps retain their existing
formats. The historical `go-collector*.json` names are deliberately unchanged.
JSH virtual paths must still be translated to actual OS paths before invoking
the executable. Parent death stops readers, drains accepted work and exits.

Each Job has one native reader thread. That same thread waits for its timer,
performs DBUS send/poll/receive, parses the reply and hands the typed row buffer
to the shared bounded queue. There is no Go scheduler, receiving goroutine or
CGo transition. `libsystemd` does not add a separate receiving worker to this
path. A single ordinary-priority writer owns the native appender and its
periodic Flush. Ordinary control workers, checkpoint work and one bounded
logging worker remain outside the FIFO reader path.

Both timer choices retain epoch-aligned fixed-rate scheduling. Standard mode
uses a relative Linux timer wait; absolute mode uses a monotonic absolute
deadline. Missed boundaries are skipped rather than replayed. Reader timing
includes buffer/queue-slot acquisition and DBUS connection preparation, through
queue handoff. Append/Flush and the initial durable wait remain outside it.
Wire integers keep their 64-bit precision; signed/IEEE conversion precedes the
configured arithmetic. A failed Call discards the entire cycle buffer.

Four row buffers are prepared per Job; at most 32 idle buffers are cached.
Leases keep their pool alive through queued/in-flight append and return exactly
once on success, error and cancellation. Stop drains the Job and retires its
pool; late returns to a retired pool are discarded. Large row buffers return
immediately after synchronous native append. Only small completion records wait
for the periodic Flush. A fatal writer error also completes queued/in-flight
ownership before the daemon exits, allowing the service to recover.

The writer keeps the current native backend's periodic Flush policy (1 second
by default), including the first-batch handshake and logical Job Stop. It does
not add a Flush per batch. Native SDK buffering is managed by the SDK; the
retained pure-Go backend's `flushMaxRows` batching setting is not a C CLI batch
size. Closing an appender still flushes its pending input. When idle, the shared
appender remains open as before, so stop the collector service before dropping
its table manually.

## Scheduling and configuration

Use the existing [Docker scheduling guide](../docs/LS_DOCKER_SCHEDULING.md).
`mode`, `fifoPriority` (0..99) and `nice` (-20..19) retain their semantics and
range correction logs. `off` leaves inherited priorities unchanged;
`conditional` applies them only in the confirmed environment and can fall back;
`force` attempts application regardless of that environment and fails on an
application error. Priority 0 selects ordinary scheduling; 1..99 selects FIFO,
with larger numbers having higher priority. Lower nice values have higher
ordinary scheduling priority. Conditional mode requires Docker and an explicitly
restricted cgroup cpuset; a CPU quota alone is insufficient. CPU numbers are
detected from the environment, never hardcoded. Non-RT kernels use the same
Linux calls; latency guarantees do not follow from successful application.

Nice is applied before creating native threads. FIFO is applied only after TAG
preparation, and restored before reader teardown/drain. Requested and effective
settings and the reader's OS TID are logged. Permission failures fall back in
conditional mode and fail in force mode. `gomaxprocs` is accepted for unchanged
configuration compatibility but has no effect in C++; startup logs state
`implementation=cpp gomaxprocs=not-applicable`.

Change `settings.json` and restart the collector service to apply internal
writer/performance/scheduler policy. JSH regenerates the policy snapshot. Job
timer selection takes effect on the next logical Job Start. Hot log-level
changes remain available through the existing monitoring API. Rotation and
performance summary formatting run in the logging worker, not the reader.

The vendored JSON and systemd headers retain their license notices under
`vendor/`. No generic collector behavior is changed by this implementation.
