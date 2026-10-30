# Task: Claude main with ACP subagents

Status: v1 built, tests passing, installed (2026-10-30). This plan replaces Claude Code's built-in `Task` with widecode's own `Task`,
served over MCP as `mcp__widecode__Task`, which runs subagents on configured ACP agents and models
(for example opencode with `opencode-go/deepseek-v4.1-flash`).

## Goal

Claude plans and edits, delegates through `Task`, and delegated work streams into the same
conversation with its own model, tools, permissions, status and lifetime.

## Non-goals for v1

- No remote isolation.
- No subagent persistence across widecode restarts.
- No translation of widecode's Claude permission rules into opencode's permission model.
- No widecode MCP tools inside the subagent beyond what is explicitly decided.
- No built-in Claude subagents once `Task` is hidden. Replacement is all-or-nothing.

## Constraints

- MCP tool names are `mcp__<server>__<tool>`. A bare model-visible `Task` is impossible for an MCP
  tool. widecode's UI strips the prefix for display.
- Claude Code gives the caller's tool-use id in `_meta["claudecode/toolUseId"]`. That anchors the
  subagent events under Claude's call card.
- `api.conversation.apply` rejects events from a plugin that is not the chosen agent and mutates the
  main status. A separate subagent event channel is required.
- Claude's `Task` supports background runs, resume, `TaskStop`, `SendMessage`, custom agent types
  and worktree isolation. Full parity means implementing or explicitly rejecting those.

## Configuration

```json
{
  "plugins": {
    "acp": {
      "tasks": {
        "replaceClaudeSubagents": true,
        "targets": {
          "deepseek": {
            "agent": "opencode",
            "model": "opencode-go/deepseek-v4.1-flash",
            "description": "Fast, cheap subagent for searches and edits"
          },
          "opencode": {
            "agent": "opencode",
            "description": "opencode's default model"
          }
        },
        "maxConcurrent": 4,
        "timeoutMs": 1800000,
        "subagentTools": false
      }
    }
  }
}
```

## Tool contract

Name: `Task`, MCP name `mcp__widecode__Task`.

```json
{
  "description": "short label",
  "prompt": "the whole task",
  "subagent_type": "deepseek",
  "model": "opencode-go/deepseek-v4.1-flash",
  "cwd": "/path/to/folder",
  "name": "optional display name",
  "run_in_background": false,
  "isolation": "none"
}
```

v1 accepts `description`, `prompt`, `subagent_type`, `model`, `cwd`, `name`.
`run_in_background` and `isolation` are rejected with a clear error until phase 6.
The result is the subagent's final text plus an agent id and usage.

## Slices

### Slice 1: MCP call context and cancellation

- [x] `McpCall` carries `toolUseId` from `_meta["claudecode/toolUseId"]`.
- [x] `McpServer` has an `onToolCancel` hook, called by `notifications/cancelled` and by a response that closes first.
- [x] The runtime passes `{ callId, toolUseId, onCancel }` to a plugin tool's `call`.
- [x] The prelude, `widecode.d.ts` and `test/api.test.ts` agree.
- [x] Test: a fake MCP client sends `_meta`, the tool receives the id and cancel runs.

### Slice 2: subagent event channel

- [x] `applySubagentEvents(model, callId, events)` exists in `@widecode/conversation`.
- [x] `api.conversation.subagent(callId, events)` applies model-only events under the call.
- [x] Events are dropped when the call or its turn is gone.
- [x] No `StatusInfo` mutation.
- [x] `api.conversation.ask` accepts a parent call id.
- [x] Tests: nesting, drop after turn close, asks under the card, main status unchanged.

### Slice 3: ACP session runner

- [x] A `SubagentRun` in `plugins/acp.ts` starts a target entry, sets the model, prompts, maps updates, cancels and closes.
- [ ] Later: extract one ACP session client shared with the existing agent adapter (the adapter still has its own closure).
- [x] Tests: the Task test runs a second session against `fake-acp.mjs`; the existing ACP tests still pass.

### Slice 4: Task tool

- [x] `plugins/acp.ts` registers `Task` when `tasks.targets` is configured.
- [x] Targets generate `subagent_type` and the description.
- [x] The call starts a runner with the Claude tool-use id.
- [x] `facts`, `task`, nested events, `taskUpdate` and the final result are emitted.
- [x] The Agents tab, Tools tab and code column show the run.
- [x] Tests: a Claude tool-use id calls `Task`, fake ACP runs the target, nested events and result.

### Slice 5: replacement, permissions, lifecycle

- [x] Claude starts with `--disallowedTools Task,Agent,TaskStop,SendMessage` when the replacement is configured and `Task` is offered.
- [x] A config escape hatch keeps the built-in (`plugins.claude.keepSubagents`).
- [x] The fixed system prompt names the widecode tools, `Task` among them; the tool description says it runs another model.
- [x] ACP permission asks open under the subagent card and answer the ACP option.
- [x] MCP cancellation and a closed MCP response kill runs; plugin stop kills the processes it owns.
- [ ] Later: a core turn-end hook so `/new` and a main-agent reset stop runs without waiting for the MCP response to close.
- [x] Concurrency limit and timeout.
- [x] Tests: tool list, permissions, cancellation, no recursion; parallel calls and the full lifecycle remain.

### Slice 6: parity (deferred)

- [ ] Background runs, notifications, `TaskStop`, `SendMessage`.
- [ ] Resume of a delegated run.
- [ ] Worktree and remote isolation.
- [ ] Persistence under `.widecode/sessions/<id>/tasks/<toolUseId>.jsonl` and resume replay.

## Event mapping

| ACP update | Conversation event |
|---|---|
| `agent_message_chunk` text | `block` text plus `text` deltas |
| `agent_thought_chunk` | thinking block |
| `tool_call` | `block` with category, summary, paths, command |
| `tool_call_update` input/status | `input`, `facts`, `result`, `finish` |
| diff content | `result.patch` |
| todo list, plan | `facts` todos and summary |
| `usage_update` | task summary and cost, never main `info` |
| `session/request_permission` | `conversation.ask(..., { parent: callId })` |
| process end | `taskUpdate` stopped or done plus MCP answer |

## Risks

- `_meta["claudecode/toolUseId"]` is undocumented. Guard and fall back to a non-nested card.
- ACP agents differ in capabilities. Validate targets and report unsupported features.
- MCP body limit is 1 MB. Cap or summarize the final text.
- Plugin memory is 64 MB shared. Bound live events and persist transcripts.
- Permissions differ between Claude and opencode. Do not imply parity.
- Hiding `Task` removes custom Claude subagents.

## Acceptance for v1

- Claude's tool list has no `Task` or `Agent`; it sees `mcp__widecode__Task`.
- A `Task` call runs the configured opencode model, streams steps under the call, appears in the
  Agents and Tools tabs, and returns the final text.
- Interrupting the main turn kills the subagent.
- The subagent cannot call `Task`.
- The main status bar still shows Claude's model, context and limits.
- `light-native check`, `typecheck`, tests and coverage pass.

## Log

- Plan saved.
- Slice 1: `McpCall.toolUseId`, cancellation through MCP and the runtime, tool call context, tests.
- Slice 2: `applySubagentEvents`, `conversation.subagent`, asks under a parent call, tests.
- Slice 3 and 4: `SubagentRun` and the `Task` tool in the acp plugin; targets, model, text, thinking,
  tool calls, plans, permissions, task status, result; `task.test.ts` runs it against `fake-acp.mjs`.
- Slice 5: `--disallowedTools Task,Agent,TaskStop,SendMessage` when the replacement is configured;
  `keepSubagents`; no recursion; concurrency and timeout; tests for the tool list, permissions and
  cancellation.
- `light-native check --all`, `typecheck --all`, `test widecode conversation agent` (69 tests) and
  `coverage --apps` pass.
- Live check: `opencode acp` with `opencode-go/deepseek-v4.1-flash` answered a direct ACP prompt.
  A live Claude -> Task run was blocked by the Claude session limit, where the new limit panel
  appeared with Wait, Change model and Retry. The fake end-to-end test covers Claude's tool-use id,
  the real `Task` tool path over MCP, nested steps, permissions, cancellation and the result.
- `test/drive.py` looked for the binary three folders up; it now points at `../dist/widecode`.
- Remaining for full parity: shared ACP session extraction, a turn-end hook for `/new`, background
  runs, `TaskStop`/`SendMessage`, resume, isolation and persistence.
