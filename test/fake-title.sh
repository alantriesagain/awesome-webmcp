#!/bin/sh
# A stand-in for `claude -p` when lightcode asks for a session title: records its arguments (one per
# line) in $TITLE_ARGS when set, and answers the way a model might, label and quotes included.
if [ -n "${TITLE_ARGS:-}" ]; then for a in "$@"; do printf '%s\n' "$a"; done > "$TITLE_ARGS"; fi
printf '**Title:** "Rename the helper."\n'
