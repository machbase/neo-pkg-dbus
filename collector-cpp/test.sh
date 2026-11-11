#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
flags=(-O2)
if [[ ${1:-} == asan ]]; then
  flags=(-O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer)
elif [[ $# != 0 ]]; then
  echo 'usage: bash test.sh [asan]' >&2
  exit 1
fi
mkdir -p dist/check
suffix=${1:-release}
g++ -std=c++17 -pthread -Wall -Wextra "${flags[@]}" -Isrc -Ivendor \
  tests/core_test.cpp src/model.cpp src/parser.cpp src/timer.cpp src/scheduler.cpp \
  -o "dist/check/core-tests-$suffix"
g++ -std=c++17 -pthread -Wall -Wextra "${flags[@]}" -Isrc -Ivendor \
  tests/runtime_test.cpp src/performance.cpp src/logger.cpp \
  -o "dist/check/runtime-tests-$suffix"
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 "dist/check/core-tests-$suffix"
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 "dist/check/runtime-tests-$suffix"
