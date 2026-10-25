# @widecode/harness

widecode's own coding agent, the harness: a daemon of widecode's binary (`widecode --harness`) that speaks ACP over stdio to the app's ACP plugin, talks to model APIs directly, runs its own tools and keeps its own sessions. The plan is in the repository's `PLAN.md`, milestone J; this README grows with the slices.

| File | Role |
|---|---|
| `cli.ts` | `harnessMain`: the daemon on stdio, its log under the store's `harness/logs`, the side commands the ACP entry runs (`--harness-tools <mode>`, `--harness-skills`, `--harness-sessions`, `--harness-forget <id>`), and the user's (`--harness-models`, `--harness-auth <provider>`: a key read from stdin into `~/.widecode/auth.json`, readable by the user alone) |
| `main.ts` | the same under node, for the app's tests (`node packages/harness/main.ts --harness ...`) |
| `acp/server.ts` | JSON-RPC 2.0 over stdin and stdout: requests, notifications, responses, the client's ids echoed as they came, a trace file (`--log`) |
| `acp/agent.ts` | the methods over the sessions: initialize, session/new, load, resume, fork, prompt (a prompt mid-turn steers the turn and is answered with it), cancel, set_config_option, list; `_meta.widecode` (the project's prompt and trust) kept per session |
| `acp/options.ts`, `acp/updates.ts` | the config options (model, effort, mode) and the `session/update` texts (chunks, usage, commands, options, mode) |
| `loop/` | the agent loop (a turn's requests until the model stops, tool batches between them: one call at a time when one mutates, together otherwise, the results in one message, synthetic ones after a cancel; steering between requests), its listener, the abort |
| `model/` | the neutral message shape (parts: text, thinking with its signature, tool call, tool result, image); `client.ts` dispatching by provider; `anthropic.ts`, the Anthropic Messages API as JSON text and its events read (thinking by the model's kind, Anthropic's extras for providers that take them: cache breakpoints, eager input streaming, the effort; a refusal or an error as the stream's end; 429, 529 and server errors tried again before anything streamed); `sse.ts`; `registry.ts`, the providers (Anthropic; DeepSeek through its Anthropic-format endpoint) and models with windows, prices, thinking kinds and efforts; the fake client scripted from a JSONL fixture (text, thinking, tool calls, a hold, an error) |
| `http/stream.ts` | a streaming request behind one class, by `node` (http and https requests with per-chunk data events) or `curl` (`-N -i`, the body on stdin), chosen by the config's `http`; an idle timer, an abort |
| `tools/` | the tools, named as Claude Code names them: `Read` (numbered lines, offset and limit, caps), `Bash` (a command in the folder through `proc.ts`, output capped to its start and end, a timeout, killed on abort); the set of a mode (plan mode's read-only share), the tools' JSON for the API, an input checked against its schema before it runs |
| `prompt/system.ts` | the system prompt's blocks: the base text and the project's text |
| `auth.ts` | the keys: the provider's environment variable, else `auth.json` |
| `config.ts`, `paths.ts` | the `harness` section of config.json (`model`, `effort`, `compactAt`, `http`, `providers` with their models, prices and thinking kind); where the harness keeps its files |

The entry in config.json is a default of the ACP plugin, chosen with `"agent": "harness"` or `--agent harness`. A key: `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY` in the environment, or `widecode --harness-auth deepseek` with the key on stdin. Tests: `light-native test harness` (the ACP framing, the agent over the fake model with a tool batch, the Anthropic request and its events, the HTTP stream by both ways against `test/fake-model.mjs`, the tools over a temp folder, the registry, costs and keys); the app's `test/harness-agent.test.ts` drives the daemon under node as the fake agent is driven.
