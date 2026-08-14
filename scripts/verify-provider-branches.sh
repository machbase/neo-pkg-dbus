#!/bin/sh
set -eu

common=feat/dbus-collector-common
generic=feat/dbus-collector-generic
ls=feat/dbus-collector-ls

git merge-base --is-ancestor "$common" "$generic"
git merge-base --is-ancestor "$common" "$ls"
git diff --quiet "$common" "$generic" -- frontend/neo-proxy.json || true

current_branch=$(git branch --show-current)
if [ "$current_branch" = "$ls" ] && [ ! -f docs/specs/providers/DBUS_LS_PROFILE.md ]; then
  echo 'LS branch must contain docs/specs/providers/DBUS_LS_PROFILE.md' >&2
  exit 1
fi
