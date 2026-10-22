#!/usr/bin/env bash
# The local CI gate: check, typecheck, every test under node and natively, coverage, then the
# widecode selftests. A writable scriptc cache is made for the run and removed after it.
set -euo pipefail
export SCRIPTC_CACHE_DIR="${SCRIPTC_CACHE_DIR:-$(mktemp -d)}"
trap 'rm -rf "$SCRIPTC_CACHE_DIR"' EXIT
scripts/lint.sh
pnpm verify
pnpm light-native build widecode
pnpm light-native selftest widecode shell --no-build
pnpm light-native selftest widecode fake --no-build
pnpm light-native selftest widecode fake-acp --no-build
