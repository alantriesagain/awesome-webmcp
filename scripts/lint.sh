#!/usr/bin/env bash
# Prose and type rules the compiler does not see: no em dashes in app/package text, no `any`
# types. Generated and probe files are out of scope.
set -euo pipefail
files=$(git ls-files 'apps/**/*.ts' 'apps/**/*.md' 'packages/**/*.ts' 'packages/**/*.md' | grep -v '/.scriptc/' || true)
if [ -n "$files" ]; then
  if echo "$files" | xargs grep -n "—"; then
    echo "lint: em dash in the text above" >&2
    exit 1
  fi
  if echo "$files" | xargs grep -nE '(:[[:space:]]*any[,;)\]}=]|<any>|as any[,;)\]}=])'; then
    echo "lint: any type above" >&2
    exit 1
  fi
fi
