#!/usr/bin/env bash
# Compile into a private staging directory and promote it in one step.
#
# `dist/` is the published package surface and a running OpenCode host may read
# it at any moment, so it is always either the previous complete build or the
# new one: never absent, never half-written, never nested. The compiler writes
# only to `.dist.build.*`; promotion is a single rename, or a single directory
# exchange when a previous build exists. The exchange leaves the previous build
# at the staging path to be removed, so concurrent builds cannot nest output
# inside `dist/`.
set -euo pipefail
cd "$(dirname "$0")/.."

staging=$(mktemp -d .dist.build.XXXXXX)
# Take the cleanup trap first: from here on, any failure or signal removes the
# staging directory, including one from the mode fixup below.
trap 'rm -rf "$staging"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
# `mktemp` makes 0700 regardless of umask. `dist/` should keep the mode a
# compiler-created directory had under this shell's umask (0755 by umask 022),
# since a host process may read it as another user.
current_umask=$(umask)
chmod "$(printf '%04o' $(( 0777 & ~8#$current_umask )))" "$staging"

command -v python3 >/dev/null \
  || { echo "build-atomic: python3 is required to promote dist/; dist/ is unchanged" >&2; exit 1; }

# `tsc` comes from the local install, so the script works without bun's PATH shim.
tsc_bin="node_modules/.bin/tsc"
[ -x "$tsc_bin" ] || tsc_bin="tsc"
"$tsc_bin" --outDir "$staging"

# A compiler run that emitted no entry point must not replace a working build.
if [ ! -s "$staging/index.js" ] || [ ! -s "$staging/index.d.ts" ]; then
  echo "build-atomic: the staged build has no index.js/index.d.ts; dist/ is unchanged" >&2
  exit 1
fi

# Promote through the platform's own rename/exchange API. Two renames (or a
# plain `mv` onto an existing directory) can leave no `dist/` at all, or put
# the new build inside the old one; neither is allowed to be possible here.
python3 - "$staging" dist <<'PY'
import ctypes, errno, os, sys

staged, dist = sys.argv[1], sys.argv[2]

def fail(message, hint=None):
    sys.stderr.write(f"build-atomic: {message}; dist/ is unchanged\n")
    if hint:
        sys.stderr.write(f"build-atomic: {hint}\n")
    raise SystemExit(1)

if not os.path.lexists(dist):
    # Fresh checkout: no previous build to keep, so one rename is the whole
    # promotion. `os.rename` cannot nest, unlike `mv` onto an existing directory.
    try:
        os.rename(staged, dist)
        raise SystemExit(0)
    except OSError as error:
        if error.errno not in (errno.EEXIST, errno.ENOTEMPTY, errno.ENOTDIR):
            fail(f"installing the first build failed: {error.strerror}")
        # Another build installed `dist/` first; the exchange below is still safe.

if os.path.islink(dist) or not os.path.isdir(dist):
    fail(f"{dist} is a symlink or not a plain directory",
         "move it aside and rerun to install a fresh build")

libc = ctypes.CDLL(None, use_errno=True)
if sys.platform.startswith("linux"):
    # glibc/musl renameat2 wrapper: RENAME_EXCHANGE swaps the two directories.
    swap = getattr(libc, "renameat2", None)
    if swap is None:
        fail("this Python cannot exchange directories")
    swap.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    swap.restype = ctypes.c_int
    result = swap(-100, os.fsencode(staged), -100, os.fsencode(dist), 2)  # AT_FDCWD
elif sys.platform == "darwin":
    swap = getattr(libc, "renamex_np", None)
    if swap is None:
        fail("this Python cannot exchange directories")
    swap.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    swap.restype = ctypes.c_int
    result = swap(os.fsencode(staged), os.fsencode(dist), 2)  # RENAME_SWAP
else:
    fail(f"{sys.platform} has no atomic directory exchange",
         "install dist/ on a host that supports one, or unpack the package elsewhere")
if result != 0:
    fail(f"the directory exchange failed: {os.strerror(ctypes.get_errno())}")
PY
