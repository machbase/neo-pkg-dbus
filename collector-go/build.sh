#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd "$(dirname "$0")" && pwd)
out_dir="$root_dir/dist/linux-amd64"
mkdir -p "$out_dir"
cd "$root_dir"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$out_dir/neo-dbus-collector" ./cmd/neo-dbus-collector
echo "$out_dir/neo-dbus-collector"
