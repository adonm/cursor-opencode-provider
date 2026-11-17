#!/usr/bin/env bash
# Compile into a staging directory and swap it in, so a failed build never
# leaves a half-written `dist/` that `test/architecture.test.ts` and a running
# OpenCode host would read.
set -euo pipefail
cd "$(dirname "$0")/.."

staging="dist.tmp.$$"
previous="dist.old.$$"

trap 'rm -rf "$staging"' EXIT

# `tsc` comes from the local install, so the script works without bun's PATH shim.
tsc_bin="node_modules/.bin/tsc"
[ -x "$tsc_bin" ] || tsc_bin="tsc"
"$tsc_bin" --outDir "$staging"

# `dist/` is absent only between these renames, and rename is atomic on one
# filesystem, so a concurrent reader sees either complete build. A failed swap
# puts the previous build back instead of leaving no `dist/` at all.
if [ -e dist ]; then mv dist "$previous"; fi
if ! mv "$staging" dist; then
  if [ -e "$previous" ]; then mv "$previous" dist; fi
  exit 1
fi
rm -rf "$previous"
