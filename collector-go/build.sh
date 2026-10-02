#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd "$(dirname "$0")" && pwd)
out_dir="$root_dir/dist/linux-amd64"
sdk_home=${MACHBASE_HOME:-}
if [[ -z "$sdk_home" && -f "$root_dir/../../dbms-nfx/machbase_home/include/machbase_sqlcli.h" ]]; then
  sdk_home=$(cd "$root_dir/../../dbms-nfx/machbase_home" && pwd)
fi
if [[ -z "$sdk_home" || ! -f "$sdk_home/include/machbase_sqlcli.h" || ! -f "$sdk_home/lib/libmachbasecli.a" ]]; then
  echo "Machbase C SDK not found. Set MACHBASE_HOME to a Linux/amd64 SDK directory." >&2
  exit 1
fi
mkdir -p "$out_dir"
cd "$root_dir"
CGO_ENABLED=1 GOOS=linux GOARCH=amd64 \
  CGO_CFLAGS="-O2 -I$sdk_home/include ${CGO_CFLAGS:-}" \
  CGO_LDFLAGS="$sdk_home/lib/libmachbasecli.a ${CGO_LDFLAGS:-}" \
  go build -tags machcli -trimpath -ldflags='-s -w' \
  -o "$out_dir/neo-dbus-collector" ./cmd/neo-dbus-collector
echo "$out_dir/neo-dbus-collector"
