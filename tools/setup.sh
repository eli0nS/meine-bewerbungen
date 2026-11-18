#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 24 ? 1 : 0)'; then
  case "$(uname -s)" in Darwin) system=darwin ;; Linux) system=linux ;; *) exit 1 ;; esac
  case "$(uname -m)" in x86_64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) exit 1 ;; esac
  origin=https://nodejs.org/dist/latest-v24.x
  temp=$(mktemp -d)
  trap 'rm -f "$temp/SHASUMS256.txt" "$temp/runtime.tar.gz"; rmdir "$temp"' EXIT
  curl -fsSL "$origin/SHASUMS256.txt" -o "$temp/SHASUMS256.txt"
  read -r expected file < <(awk -v suffix="-$system-$arch.tar.gz" '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-/ && index($2,suffix) && length($2)==index($2,suffix)+length(suffix)-1 {print $1,$2;exit}' "$temp/SHASUMS256.txt")
  runtime="$HOME/.bewerbungsatelier/runtime"
  folder="$runtime/${file%.tar.gz}"
  if [ ! -x "$folder/bin/node" ]; then
    curl -fsSL "$origin/$file" -o "$temp/runtime.tar.gz"
    if command -v shasum >/dev/null; then actual=$(shasum -a 256 "$temp/runtime.tar.gz"); else actual=$(sha256sum "$temp/runtime.tar.gz"); fi
    [ "${actual%% *}" = "$expected" ] || { echo 'Node.js-Prüfsumme stimmt nicht.' >&2; exit 1; }
    mkdir -p "$runtime"
    tar -xzf "$temp/runtime.tar.gz" -C "$runtime"
  fi
  export PATH="$folder/bin:$PATH"
fi
node tools/launch.mjs --background "$@"
