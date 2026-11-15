# The `claude -p` protocol, as this app uses it

Measured on Claude Code 2.1.282 with `test/probe/run.mjs`; every scenario's traffic, both
directions, is in `test/fixtures/<scenario>.ndjson` (`{"dir":"out"|"in","t":ms,"raw":"<line>"}`)
with what it showed in `<scenario>.notes.txt`. Rerun a scenario after a Claude Code upgrade:
`node test/probe/run.mjs <scenario>`.

## Launch

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --forward-subagent-text --replay-user-messages
  --permission-mode bypassPermissions --permission-prompt-tool stdio
  [--model M] [--effort low|medium|high|xhigh|max] [--resume <session id>]
  [--mcp-config <file>] [--append-system-prompt <text> --system-prompt-snapshot off]
  [--settings {"permissions":{"allow":[…],"ask":[…],"deny":[…]}}]
```

In the project folder, with `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` removed from the environment.
`--mcp-config` names a file (the user's alone) with widecode's MCP server and this agent's token, when
widecode has a tool for Claude (PLUGINS.md, "widecode's own tools"); the tools come back in
`system/init`'s `mcp_servers` and `tools` as `mcp__widecode__<name>`. Claude reads the list once, so a
tool added while it runs is picked up at the turn's end: the CLI stops and the next message starts it
again with `--resume`.
`--append-system-prompt` carries the harness's text (PLUGINS.md, "The harness": a fixed paragraph,
then the trusted project's `.widecode/prompt.md`). Claude Code records the system prompt once per
session and gives a resumed session the recorded one; `--system-prompt-snapshot off` makes it take
the prompt it starts with, so `prompt.md` edited reaches the session at the turn's end, through the
same stop and `--resume` as a tool change.
`--settings` carries the tool permission rules of the user's and the trusted project's config.json
(PLUGINS.md, "Tool permissions"), inline so that a `/path` rule anchors at the project folder. The CLI
enforces them: a deny rule blocks in every mode, bypass included; an ask rule prompts in every mode,
and under `--permission-prompt-tool stdio` the prompt is a `can_use_tool` control request, which the
TUI puts to the user as a permission (allow with the original input, or deny with a message).
`AskUserQuestion` and `ExitPlanMode` are in `system/init`'s `tools` under bypass (ExitPlanMode is a
deferred tool Claude loads with ToolSearch).

## What the probes settled

| Question | Answer | Fixture |
|---|---|---|
| Does AskUserQuestion reach the host under bypass? | Yes: `control_request {subtype:"can_use_tool", tool_name:"AskUserQuestion", input:{questions:[{question, header, options:[{label, description}], multiSelect}]}, tool_use_id, requires_user_interaction:true}` | `ask` |
| How is it answered? | `control_response {subtype:"success", request_id, response:{behavior:"allow", updatedInput:{...input, answers:{"<question>": "<label>" \| ["<label>", …] \| "<free text>"}}}}`; several questions in one call, multi-select as an array, free text as a string | `ask`, `ask-multi` |
| Plan mode | `control_request {subtype:"set_permission_mode", mode:"plan"}` → `{mode:"plan"}`; `system/status` and `system/init` carry `permissionMode` | `plan` |
| ExitPlanMode | `can_use_tool` with `tool_name:"ExitPlanMode"`, `input:{}` (the plan is the text or plan file before it), `requires_user_interaction:true`. Approve: allow with `updatedPermissions:[{type:"setMode", mode:"bypassPermissions", destination:"session"}]`, which restores bypass (`system/status permissionMode:"bypassPermissions"`) | `plan` |
| Interrupt | `control_request {subtype:"interrupt"}` → `{still_queued:[]}`; the turn ends with `result subtype:"error_during_execution", terminal_reason:"aborted_streaming"`; the process stays up and the next message works | `interrupt` |
| Model | `set_model {model:"sonnet"}` → success; the next turn runs on it | `model` |
| Skills | `system/init` carries `skills` (their names; `slash_commands` holds them with the built-in commands, `terminal_slash_commands` those of the terminal alone) and `plugins` (`{name, path, source}`; a plugin's skills are `<path>/skills/<skill>/SKILL.md`, named `<plugin>:<skill>`; `anthropic-skills:*` are the synced skills under `~/.claude/skills/synced/<id>/`). A project's are `.claude/skills/<name>/SKILL.md`, the user's `~/.claude/skills/<name>/SKILL.md`; a bundled skill (code-review, simplify, …) has no file. The model loads one with the `Skill` tool (`input: {skill, args}`), its result the skill's text. A skill the user types (`/name args`) is a slash command the CLI runs: echoed as a `<command-name>` user message with `isReplay`, as `/compact` is; the skill's own expansion is not recorded yet | `turn` (the init) |
| Effort | `apply_flag_settings {settings:{effortLevel:"medium"}}` → success; no restart needed | `model` |
| Images | a user message `content` block `{type:"image", source:{type:"base64", media_type, data}}` works | `image` |
| `@file` | the CLI expands `@path` in the text itself (no tool call); the composer just inserts it | `atfile` |
| A path outside the session's folders | In a mode that asks, `can_use_tool` carries `blocked_path` (Bash: a `cd` or a path argument) or `decision_reason_type:"workingDir"` (Read), with `permission_suggestions` (the exact command as a `localSettings` rule, `Read(//<dir>/**)` for the session). Allowed with `updatedPermissions:[{type:"addDirectories", directories:[dir], destination:"session"}]`, the CLI asks nothing more about that folder while the process runs; `destination:"localSettings"` writes it to the project's `.claude/settings.local.json` as `permissions.additionalDirectories` (2.1.282, measured live on haiku) | |
| Protected paths under bypass | a write to `.claude/settings.json` asked nothing; the backend's allow rule for other `can_use_tool` requests stays as a safety net | `protected` |
| Resume | `--resume <id>` emits nothing until the next message (no history replay) and keeps the id; the page loads history from the session file | `resume` |
| A message sent mid-turn | queued in the CLI's command queue; sent while a tool runs, it is taken up right after the tool's result, within the turn (`midtool`); with no call left in the turn, it runs as its own turn (its own `result`, `midturn`). `--replay-user-messages` echoes it with `isReplay:true` (and the `uuid` it was sent with) as it is taken up | `midturn`, `midtool` |
| Taking a queued message back | the message sent with a `uuid`; `control_request {subtype:"cancel_async_message", message_uuid}` → `{cancelled:true}` while it waits in the queue (it never reaches the model), `false` once taken up (2.1.282, measured live on haiku) | |
| A side question (/btw) | `control_request {subtype:"side_question", question, history?:[{question, response}]}`, answered while a turn runs too: `system/control_request_progress {status:"started"}`, then `{response:"<text>", synthetic:false}` (`response:null` for none); the session gets nothing of it (2.1.282, measured live on haiku) | |
| Subagents | the `Agent` tool_use, then `system/task_started {task_id, tool_use_id, description, subagent_type, is_backgrounded}`, the subagent's whole messages (not deltas) as `assistant`/`user` with `parent_tool_use_id` = the Agent call's id, `system/task_progress {last_tool_name, usage}`, `task_updated`, `task_notification {summary, output_file}`, `background_tasks_changed` | `subagent` |
| Turn boundaries | `system/init` is emitted at the start of every turn; one `result` per turn; `system/thinking_tokens` and `rate_limit_event` appear too | all |
| Tool results | `user` envelopes carry `tool_use_result`: Write `{type, filePath, content, structuredPatch, originalFile, userModified}`, Edit `{filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll}` | `edit` |

## Native capabilities (probe p32)

Positioned `readSync` (file heads and tails), `statSync` size and mtime, `spawn` with `env` and
`cwd`, `Buffer.concat` decoded once, base64 both ways, and `fs.watch` on a single file all work
natively, fully static, with output identical to node.

## Decisions

1. **Bypass plus a host channel.** `bypassPermissions` with `--permission-prompt-tool stdio`.
   Under bypass the CLI sends a `can_use_tool` only for what no mode auto-approves: AskUserQuestion
   and ExitPlanMode, which the TUI shows as a question and a plan, and the tools the permission
   rules (`--settings`) or the CLI's own checks make it ask about, which the TUI shows as a
   permission the user allows or denies. Nothing is allowed behind the user's back.
2. **Effort changes live** through `apply_flag_settings`; no restart.
3. **Plan approval restores bypass** through `updatedPermissions` `setMode`.
4. **One process, lines parsed in-process.** The frontend became a TUI (light's `tdom`), so there
   is no bridge: the session's stdout lines are parsed where they are drawn. Native `JSON.parse`
   takes about 10 ms for a 5.6 MB Edit result and 6 ms for 5000 text deltas
   (probe p34), so every line is parsed and none is skipped. (An earlier desktop
   page measured light's bridge for this, which led to `emitJson` in light.)
5. **Diffs from git, no syntax colors in v1.** `@bootstrapp/editor`'s tokenizers and Myers diff
   compile 96% statically but not fully (records of functions, generic state, an optional
   destructured parameter blocks `diffLines`; probe p33), so the code view gets
   its hunks from `git diff -U<all> HEAD` and shows plain text; a native tokenizer can come later.
6. **Windowed line views, rendered by templates.** A frame where all 200 rows of 10 styled runs
   change costs 10.5 ms natively (4.5 ms under node; probe p35); a pane is about
   60 rows, so the chat, tree and code views render only their visible rows as `<p wrap="none">`
   with `<span>` runs, without building nodes by hand.
