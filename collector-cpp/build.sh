#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo 'LS collector builds require Linux/amd64.' >&2
  exit 1
fi
variant=${1:-release}
sdk=${MACHBASE_HOME:-../../dbms-nfx/machbase_home}
if [[ ! -f "$sdk/include/machbase_sqlcli.h" || ! -f "$sdk/lib/libmachbasecli.a" ]]; then
  echo 'Set MACHBASE_HOME to the CLI SDK directory containing include/ and lib/.' >&2
  exit 1
fi
output=dist/linux-amd64
objects="$output/objects-$variant"
mkdir -p "$objects"
flags=(-O2 -DNDEBUG)
suffix=''
link=(-static-libstdc++ -static-libgcc -s)
case "$variant" in
  release) ;;
  testing) flags+=(-DCOLLECTOR_TESTING); suffix=-testing ;;
  asan|asan-testing)
    flags=(-O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer)
    suffix=-$variant; link=(-fsanitize=address,undefined)
    [[ $variant != asan-testing ]] || flags+=(-DCOLLECTOR_TESTING)
    ;;
  *) echo 'usage: ./build.sh [release|testing|asan|asan-testing]' >&2; exit 1 ;;
esac
includes=(-Isrc -Ivendor -I"$sdk/include")
warnings=(-Wall -Wextra)
stamp=$({
  gcc --version
  g++ --version
  printf '%s\n' "$sdk" "${flags[*]}" "${includes[*]}"
  sha256sum "$sdk/include/machbase_sqlcli.h" "$sdk/lib/libmachbasecli.a"
} | sha256sum)
recorded=$(cat "$objects/configuration.txt" 2>/dev/null || true)
if [[ $recorded != "$stamp" ]]; then
  rm -f "$objects/"*.o
  printf '%s\n' "$stamp" > "$objects/configuration.txt"
fi
needs_compile() {
  local object=$1 dependency
  shift
  [[ -f "$object" ]] || return 0
  for dependency in "$@" build.sh src/*.hpp src/*.h vendor/nlohmann/json.hpp; do
    [[ "$dependency" -nt "$object" ]] && return 0
  done
  return 1
}
if needs_compile "$objects/native_bridge.o" src/native_bridge.c src/*.inc; then
  gcc -std=gnu11 "${flags[@]}" "${warnings[@]}" "${includes[@]}" -c src/native_bridge.c -o "$objects/native_bridge.o"
fi
for source in model parser timer scheduler logger performance native_db daemon reader writer server; do
  if needs_compile "$objects/$source.o" "src/$source.cpp"; then
    g++ -std=c++17 -pthread "${flags[@]}" "${warnings[@]}" "${includes[@]}" -c "src/$source.cpp" -o "$objects/$source.o"
  fi
done
g++ -pthread "${link[@]}" "$objects/"*.o "$sdk/lib/libmachbasecli.a" -Wl,-l:libsystemd.so.0 -lm -ldl -lrt -o "$output/neo-dbus-collector$suffix"
chmod 755 "$output/neo-dbus-collector$suffix"
printf '%s\n' "$PWD/$output/neo-dbus-collector$suffix"
