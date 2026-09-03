# LS Go collector

`neo-dbus-collector` is only staged by `npm run build -- --target=ls`.  It is
not part of the generic package.

Build the Linux/amd64 executable:

```bash
./build.sh
```

The daemon reads the JSH-created `cgi-bin/conf.d/go-collector.json` and the
0600 `go-collector-secrets.json`.  JSH starts one daemon service and invokes
the executable with `--control start|stop|reload <job-name>` for logical Job
control.  The daemon maintains a single native writer and an epoch-aligned,
fixed-rate reader per running Job.
