# ACP, as the `acp` plugin uses it

ACP, the Agent Client Protocol (agentclientprotocol.com), is JSON-RPC 2.0 over the agent's stdin
and stdout, one message per line. lightcode is the client; `plugins/acp/index.ts` speaks it.

Measured on opencode 1.19.2 with `test/probe/acp.mjs` (`LIGHTCODE_LIVE=1`, on
opencode's free `big-pickle` model, in a temporary repository): a reply, a bash call, a read and an
edit, a cancel during `sleep 30`, `session/list`, and a second process loading the session. Every
line both ways is in `test/fixtures/acp-opencode.ndjson` (`{"dir":"out"|"in","t":ms,"raw":"<line>"}`,
the repository written as /tmp/PROJECT), with what it showed in `acp-opencode.notes.txt`.
`test/fake-acp.mjs --replay` plays it back for `test/acp-opencode.test.ts`; without
`--replay` the fake is a scripted agent that speaks as 1.19 does, or as 1.2.10 did with
`--legacy` (read from that version's source). Rerun the probe after an opencode upgrade:
`LIGHTCODE_LIVE=1 node test/probe/acp.mjs` (`--models` lists the models and stops).

## Launch

```
opencode acp
```

In the folder, with `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` removed from the environment (the
core's `api.process.spawn` does this for every agent). The process serves every session; lightcode
keeps one running and starts it again on the next message if it ends.

## Calls lightcode makes

| Call | Params | Answer |
|---|---|---|
| `initialize` | `{protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}, clientInfo}` | `{protocolVersion, agentCapabilities: {loadSession, mcpCapabilities: {http, sse}, promptCapabilities: {image, embeddedContext}, sessionCapabilities: {list, resume, fork, close}}, authMethods, agentInfo}` |
| `session/new` | `{cwd, mcpServers}` | `{sessionId, configOptions}` (1.2: `{sessionId, modes, models}`) |
| `session/load` | `{sessionId, cwd, mcpServers}` | the session's messages as `session/update`s first, then `{configOptions}` |
| `session/resume` | `{sessionId, cwd, mcpServers}` | `{configOptions}`, no replay (for an agent that has no `session/load`, such as the DeepSeek Harness) |
| `session/prompt` | `{sessionId, prompt: [{type: "text", text}, {type: "image", mimeType, data}]}` | `{stopReason, usage: {inputTokens, outputTokens, totalTokens, thoughtTokens, cachedReadTokens}}` once the turn ends |
| `session/cancel` | `{sessionId}` (a notification) | the prompt answers `cancelled` |
| `session/set_config_option` | `{sessionId, configId, value}` | `{configOptions}` |
| `session/set_mode`, `session/set_model` | `{sessionId, modeId}`, `{sessionId, modelId}` | `{}` (for an agent without config options) |
| `session/list` | `{cwd}` | `{sessions: [{sessionId, cwd, title, updatedAt}], nextCursor?}` |

`stopReason` is `end_turn`, `cancelled`, `refusal`, `max_tokens` or `max_turn_requests`.

A past session is reopened with `session/load` when the agent advertises `loadSession`, its turns
replayed; else with `session/resume` when it advertises that (the DeepSeek Harness: its earlier
turns are not shown, and lightcode says so); else a new session starts.

`mcpServers` is `[{type: "http", name: "lightcode", url, headers: [{name: "Authorization", value:
"Bearer <token>"}]}]`, lightcode's own tools (PLUGINS.md), when the agent's `mcpCapabilities.http` is
true and a plugin added a tool; `[]` else.

A config option is `{id, name, category, type: "select", currentValue, options}`, its options
`{value, name, description?}` or groups of them (`{group, name, options}`). opencode offers
`model` (category `model`: 86 `provider/model` values on an OpenCode Zen login), `effort`
(category `thought_level`, for a model with variants) and `mode` (`build`, `plan`). The plugin
keeps them by category: the model, effort and mode the status shows, and the values a switch of
model, effort or mode may take.

## What the agent sends

`session/update` notifications, `{sessionId, update: {sessionUpdate, …}}`:

| `sessionUpdate` | Fields | lightcode shows |
|---|---|---|
| `agent_message_chunk` | `messageId, content: {type: "text", text}` | the reply; chunks of one message joined, another message another block |
| `agent_thought_chunk` | the same (`messageId` is the thought's part) | thinking |
| `user_message_chunk` | the same; a part with `annotations.audience: ["assistant"]` was for the agent alone | a turn's prompt, while a session loads; another message, another turn |
| `tool_call` | `toolCallId, title, kind, status, locations: [{path}], rawInput` | a call: `kind` gives its category and name |
| `tool_call_update` | any of a call's fields | the call's facts; `completed` or `failed` gives its result and diff |
| `config_option_update` | `configOptions` | the model, effort and mode |
| `current_mode_update` | `currentModeId` | the mode (1.2) |
| `plan` | `entries: [{content, priority, status}]` | a todo list (1.2) |
| `available_commands_update` | `availableCommands: [{name, description}]` | the agent's commands |
| `usage_update` | `used, size, cost: {amount, currency}` | the context used and its size, the cost |

A call's `kind` is `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`,
`switch_mode` or `other`; its `content` holds `{type: "content", content: {type: "text", text}}`,
`{type: "diff", path, oldText, newText}` and `{type: "terminal", terminalId}` blocks.

`session/request_permission` is a request, `{sessionId, toolCall, options: [{optionId, name,
kind}]}` with kinds `allow_once`, `allow_always`, `reject_once`, `reject_always`. The request panel
asks it as a question of those options; the answer is `{outcome: {outcome: "selected", optionId}}`,
or `{outcome: "cancelled"}` for one withdrawn by a cancel (ACP asks the client to answer those
before it cancels). A request lightcode does not offer (`fs/*`, `terminal/*`) is answered with
error -32601.

## opencode 1.19.2

- A call comes as `tool_call` `pending` with its tool's name as its title (`bash`, `read`, `edit`)
  and an empty input (a bash call's has its `cwd`); then `in_progress` updates with the input, the
  locations and, for a command, its title (the command) and output so far; then `completed` with
  the tool's own title (a path relative to the project; a command's stays the command), the output
  as text content, and `rawOutput: {output, metadata}`, its kind and locations left out. So a
  call's line comes from its input once it has one, a command's line is the command, and a call's
  kind is remembered from its first updates.
- A command's location is the folder it runs in; lightcode lists no file for it.
- An edit's `diff` content holds the strings replaced (`oldString`, `newString`), numbered from 1;
  `rawOutput.metadata.diff` and `filediff.patch` hold the unified diff with the file's line numbers,
  which lightcode shows. (1.2's `filediff` held the whole file `before` and `after`, and lightcode
  diffs those.)
- A todo list is a `todowrite` call with the list in its input (`todos: [{content, status,
  priority}]`), and a subagent a `task` call (kind `think`) with `subagent_type`, `description`
  and `prompt`; lightcode reads both from the input. 1.2 also sent the list as a `plan`.
- A loaded session replays its messages, each call as a `tool_call` and a `completed` update.
- A cancel answers the prompt `cancelled`, then reports `used: 0`; lightcode keeps the context it
  had. (1.2 answered `end_turn`, so lightcode remembers that the user cancelled.)
- Permissions are asked for what opencode's config marks `ask`; the request's `toolCall.title` is
  a summary of the call (a command, a path).
- `usage_update` follows each turn and each load; the prompt's answer carries the turn's tokens.
- `opencode session list --format json` lists the project's sessions without the ACP process
  running, `[{id, title, updated, created, projectId, directory}]` (times in ms; nothing at all
  when there are none); the plugin uses it for the Sessions tab until the agent runs, then
  `session/list`.
- ACP has no list of the agent's tools. `opencode debug agent <mode>` prints the mode's agent as
  JSON, its `tools` an object of names, each true or false (about 1.3 s, without the ACP process);
  `invalid` is opencode's stand-in for a call it cannot read, and `question` is left out for an
  ACP client, so the plugin leaves both out. The list is what the mode has registered: plan mode
  lists `edit` and `write` too. Its `permission` rules (`{permission, pattern, action}`) say what
  a call meets: the last rule matching both its permission (wildcards `*` and `?`; `write` and
  `apply_patch` are `edit`'s) and its pattern decides, `ask` when none does, and a tool whose last
  rule for its permission denies `*` is taken from the model. Plan mode denies `edit` but on
  `.opencode/plans/*.md` (and the same folder under opencode's data folder).
- Nor of its skills. `opencode debug skill` prints every skill it loads as JSON, `[{name,
  description, location, content}]` (about 140 KB with the contents; a built-in one's location is
  `<built-in>`): the project's `.claude/skills` and `.opencode/skill`, the user's `~/.claude/skills`
  (its synced folder included) and `~/.config/opencode/skill`. The model loads one with the `skill`
  tool, the skill's `name` in its input; the entry's `skills` command reads the list once the
  session is made. A skill is not one of `available_commands_update`'s commands (those are
  `.opencode/command/*.md`), so one is asked for in words.
- A live call's first `tool_call` is titled with its tool's name (`bash`, `read`, `edit`,
  `lightcode_AskUser`); a loaded session's calls come titled with what they did, so their tool is
  not known.
- A server in `mcpServers` with a `type` is an HTTP (or SSE) one, without a stdio command; opencode
  connects to it while it makes or loads the session (the same name and config once per process)
  and names its tools `<server>_<tool>` (`lightcode_AskUser`, characters other than letters, digits,
  `_` and `-` made `_`). A call is a `tool_call` titled with
  that name, kind `other`. Its MCP client sends a progress token with each call and starts its
  60 s timeout again on each progress notification.
- Under ACP opencode leaves out its own question tool (on only for its app, CLI and desktop
  clients, or with `OPENCODE_ENABLE_QUESTION_TOOL`, and it does not forward the question over ACP)
  and its plan tool (its CLI only, with `OPENCODE_EXPERIMENTAL_PLAN_MODE`): lightcode's
  `AskUser` and `PresentPlan` stand in for them.
- A `session/prompt` sent while a turn runs is taken into that turn: opencode's next step reads it
  (sent during a `sleep 6` call, "also say BANANA" was in the turn's reply), and both prompts are
  answered together when the turn ends, with the same `stopReason` and `usage`.
- `session/fork {sessionId, cwd, mcpServers}` replays the session under the fork's id before it
  answers `{sessionId, configOptions}`; a prompt there answers from the session's context, and the
  fork stays in opencode's list (titled "… (fork #1)") until `opencode session delete <id>`.
- `session/new` makes a session opencode keeps at once, titled "New session - <time>", before
  anything is written to it. lightcode makes one at launch (its config options say the models and
  efforts), so one left unwritten is deleted with `opencode session delete <id>` when it is left for
  another, or by the next lightcode when this one quit on it.
- A mode set during a turn holds from the next prompt: opencode keeps it with the session and
  passes it with each `session/prompt`, so the turn goes on in the mode it started in.
- `opencode auth login` with no argument picks a provider; `-p <provider>` names it. An argument
  is the URL of a self-hosted login server.
