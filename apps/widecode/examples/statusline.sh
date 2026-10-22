#!/bin/sh
# A status line script in Claude Code's format, to show widecode runs them unchanged: it reads the
# status JSON on stdin and prints one colored line. Use it in Claude Code
#   "statusLine": { "type": "command", "command": "~/path/to/statusline.sh" }
# or as a widecode segment in ~/.widecode/config.json
#   "statusline": { "lines": [ ..., [ { "command": "~/path/to/statusline.sh", "interval": 5 } ] ] }
# Needs jq.
input=$(cat)
field() { printf '%s' "$input" | jq -r "$1 // empty"; }
model=$(field '.model.display_name')
used=$(field '.context_window.used_percentage')
dir=$(basename "$(field '.workspace.current_dir')")
hit=$(field '.prompt_cache.hit_ratio')
five=$(field '.rate_limits.five_hour.used_percentage')
printf '\033[38;5;110m%s\033[0m \033[90min\033[0m \033[1m%s\033[0m' "${model:-claude}" "${dir:-?}"
[ -n "$used" ] && printf ' \033[90m·\033[0m context \033[33m%s%%\033[0m' "$used"
[ -n "$hit" ] && printf ' \033[90m·\033[0m cache hits \033[32m%s\033[0m' "$hit"
[ -n "$five" ] && printf ' \033[90m·\033[0m 5h \033[35m%.0f%%\033[0m' "$five"
printf '\n'
