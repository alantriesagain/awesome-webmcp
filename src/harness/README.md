# src/harness

widecode's own coding agent, the harness: a daemon of widecode's binary (`widecode --harness`) that speaks ACP over stdio to the app's ACP plugin, talks to model APIs directly, runs its own tools and keeps its own sessions. The plan is in the repository's `PLAN.md`, milestone J; this README grows with the slices.

| File | Role |
|---|---|
| `cli.ts` | `harnessMain`: the daemon on stdio, its log under the store's `harness/logs`, the side commands the ACP entry runs (`--harness-tools <mode>`, `--harness-skills`, `--harness-sessions`, `--harness-forget <id>`), and the user's (`--harness-models`, `--harness-auth <provider>`: a key read from stdin into `~/.widecode/auth.json`, readable by the user alone) |
| `main.ts` | the same under node, for the app's tests (`node src/harness/main.ts --harness ...`) |
| `acp/server.ts` | JSON-RPC 2.0 over stdin and stdout: requests, notifications, responses, the client's ids echoed as they came, a trace file (`--log`) |
| `acp/agent.ts` | the methods over the sessions: initialize, session/new, load (a session this process does not hold is read from its file and its turns shown again before the answer), resume (no replay), fork (the branch copied into a file of its own), prompt (a prompt mid-turn steers the turn and is answered with it; `/title [words]` names the session), cancel, set_config_option, list (the folder's files); `_meta.widecode` (the project's prompt and trust) kept per session; after the first turn a cheap model of the provider names the session |
| `acp/options.ts`, `acp/updates.ts` | the config options (model, effort, mode) and the `session/update` texts (chunks, usage, commands, options, mode) |
| `loop/` | the agent loop (a Task call runs a subagent: its prompt as a session of its own on the same model and folder with the tools but Task, its last reply the call's text, its cost the session's; a turn's requests until the model stops, tool batches between them: one call at a time when one mutates, together otherwise, the results in one message, synthetic ones after a cancel; steering between requests), its listener, the abort; `compact.ts`, compaction in pi's shape (past the threshold, the window less a reserve or the config's `compactAt`, the messages before the last 20,000 tokens are summarized by the model into a fixed structure, the summary sent as the first user message from then on; `/compact [hint]` summarizes everything so far); `tokens.ts`, the estimate (four characters a token, corrected by the last request's count) |
| `ext/` | the harness's half of widecode's plugins, from the built-ins the app hands it, the store's `plugins/` (`~/.widecode/plugins`) and a trusted folder's `.widecode/plugins/`, in the app's order: an id defined again replaces the earlier. One engine per (folder, trusted) pair evaluates every file once to learn which ids have an `agent(agent)` part; none leaves no engine. A session evaluates the files of its agent parts again as an instance of its own (a Task subagent on its parent's), so module state is the session's; `prelude.ts` puts light's prelude first, for the `widecode.util`, `widecode.theme` and `widecode.version` a plugin's top level reads, then the harness's `widecode.plugin`, which records the agent part and never runs `activate`; `messages.ts` converts the conversation to the agent's message shape, following pi's `AgentMessage`, and back; the agent object (`on`, `registerTool`, `registerCommand`, `exec` a child process without a shell answering `{ stdout, stderr, code, killed, truncated }`, `settings`, `getAllTools`, `getActiveTools` and `setActiveTools` for the tools the session has and offers, `setModel`, `getThinkingLevel` and `setThinkingLevel` for its options, and `events` (`on` returns an unsubscribe, `emit` calls the handlers synchronously) between the plugins of one session's instance, and `app` (`send` notifies the client over `_widecode/plugin`, and `on` hears the app's messages, which `receivePlugin` hands to the instance)) is keyed by the instance, and a callback's promise is answered through the host, with a host answer that comes later settled back into the waiting call; `extensions.ts` holds the engine, the 250 ms budget, the plugin switches from `config.json`'s `plugins.<id>: false`, a context per call by id, the handlers for `session_start`, `before_agent_start`, `context`, `tool_call` and `tool_result` (with the harness's own tool names and inputs), the turn's (`agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`), `input` (a transform feeds the next handler, handled answers without a turn), `model_select` and `thinking_level_select`, `session_before_compact` (cancel it or give its summary), `session_compact`, `session_before_fork` and `session_shutdown`, and the registered tools and commands; `/reload` runs every plugin of the session's folder and trust again, and `agent.reload()` does the same from a plugin; it watches the store's `plugins/` and a trusted folder's `.widecode/plugins/` and each plugin's own folder, and a changed or added file is evaluated again and reloaded in every live session (its handlers get `session_shutdown`, its registrations are dropped, its `agent(agent)` runs again and its new handlers get `session_start`, both with reason `reload`), a removed one is dropped, and a file switched off for its budget gets a fresh chance; `ctx.ui` reaches the client over `_widecode/ui` when its initialize says so: a dialog as a request, a notification as a notification, both with the call's session id |
| `model/` | the neutral message shape (parts: text, thinking with its signature, tool call, tool result, image); `client.ts` dispatching by the model's API; `openai.ts`, an OpenAI-compatible chat completions API (tool calls and their results as tool messages, a reasoning model's `reasoning_content` read and sent back on the assistant's messages, which DeepSeek and Kimi require with tools, thinking toggled or an effort by the model's kind, the cached share of the usage); `anthropic.ts`, the Anthropic Messages API as JSON text and its events read (thinking by the model's kind, Anthropic's extras for providers that take them: cache breakpoints, eager input streaming, the effort; a refusal or an error as the stream's end; 429, 529 and server errors tried again before anything streamed); `sse.ts`; `registry.ts`, the providers (Anthropic; DeepSeek through its Anthropic-format endpoint) and models with windows, prices, thinking kinds and efforts; the fake client scripted from a JSONL fixture (text, thinking, tool calls, a hold, an error) |
| `http/stream.ts` | a streaming request behind one class, by `node` (http and https requests with per-chunk data events) or `curl` (`-N -i`, the body on stdin), chosen by the config's `http`; an idle timer, an abort |
| `tools/` | the tools, named as Claude Code names them: `Read` (numbered lines, offset and limit, caps; what it read may be edited), `Write` (a whole file, its folders made, refused for an unread file), `Edit` (an exact unique string replaced, or every occurrence; CRLF, BOM and the mode kept; the patch with line numbers as the result), `Bash` (a command in the folder through `proc.ts`: its whole output written to `<store>/harness/output/<session>/<callId>.log`, 30 KB of it kept in the result with the file named when more was cut, a timeout, killed on abort; `run_in_background` starts it and answers at once with its id and file, up to 8 running together, its end sent to the session as a user message when idle or steered into a turn), `BashOutput` (a background command's output so far, from an offset or its last lines, whether it runs and its exit code), `BashStop` (ends one and its process group), `Grep` (ripgrep when on PATH, else grep), `Glob` (the workspace's file list, newest first), `LS`, `Skill` (a skill's instructions by name), `permissions.ts` (the calls `permissions.deny` refuses, the user's config's and a trusted project's, in Claude Code's syntax: Bash patterns over each simple command, gitignore-style paths for Read and Edit, WebFetch domains, tools and MCP servers whole; a refused call ends with its rule), `WebFetch` and `WebSearch` (`web.ts`: a page through the browser, else curl; a page with a prompt longer than 10,000 characters is read by the model, which answers the prompt from up to 100,000 characters of it, and the answer is the result, its cost counted as a subagent's (`harness.fetchModel` reads it on another model); a short page, or a call without a prompt, comes as markdown cut at 50,000 characters; a search over the backends in order until one gives results: SearXNG when `harness.search.searxng` names an instance, Brave's and Tavily's APIs with a key, Exa's hosted MCP server (no key needed), Google through the browser, DuckDuckGo's HTML page only when `harness.search.order` lists it); `browser.ts`, headless Chromium (the config's `harness.browser.command`, else Playwright's headless shell or Chromium under `~/.cache/ms-playwright`, else one on PATH) run once per page with a fresh profile under the store, its DOM printed after the scripts ran; `html.ts`, a page's HTML as markdown (its main content, links resolved); `mcp.ts`, the MCP servers the client gives a session (widecode's own over HTTP with its token): their tools listed when the session opens, offered as `mcp__<server>__<tool>` and titled `<server>_<tool>` for the client, a call read to the end of its event stream and dropped on abort; `patch.ts`, the Myers line diff and the unified patch the code column follows; the set of a mode (plan mode's read-only share), the tools' JSON for the API, an input checked against its schema before it runs |
| `session/` | a session's file under `~/.widecode/harness/sessions/<folder key>/<id>.jsonl` in pi's shape (`entries.ts`: a header line, then entries with `id` and `parentId`, the branch the walk back from the last one: a message with its parts, a model or mode change, a title, a compaction, and after each request its usage: the tokens, the cost, whether a side request's such as a subagent's or a page read, which a resumed session adds back to its cost and a plugin reads as a `custom` entry); `store.ts`, the files: made on the first entry (a session never written leaves nothing), appended to, loaded as the branch, listed through the header and the tail (the last title), forked as a copy, removed with its Bash output folder; a tool result keeps its outcome as JSON, which `replay.ts` turns back into completed calls with their diffs when a load shows the turns again, paced; `title.ts`, the session's title asked of the provider's cheapest model with the agent package's naming prompt |
| `prompt/` | the system prompt (`system.ts`): stable blocks first, cached where the provider caches (the base text with how to use the tools, the folder and platform, the project's text from the client, the project's instructions, the skills), then a small block that changes (the date, plan mode's note) sent last and uncached; `context-files.ts`, AGENTS.md, CLAUDE.md and .claude/CLAUDE.md from the repository's root down to the folder (a trusted folder's), then `~/.widecode/harness/AGENTS.md`, cut at 32 KB a file and 128 KB in all, a file with another's text left out; `skills.ts`, the skills in the Agent Skills format from the folder's `.agents/skills`, `.claude/skills` and `.pi/skills` and each plugin folder's `skills` under its `.widecode/plugins` (trusted), the user's `~/.agents/skills`, `~/.claude/skills` and its synced folders, pi's `~/.pi/agent/skills` (`PI_CODING_AGENT_DIR` when set), each plugin folder's `skills` under the store's `plugins` and `~/.widecode/harness/skills`, listed by name and description (`disable-model-invocation` keeps one out of the prompt); `templates.ts`, prompt templates in pi's format from the folder's `.widecode/prompts` and `.pi/prompts` and each plugin folder's `prompts` under its `.widecode/plugins` (trusted), `~/.widecode/harness/prompts`, each plugin folder's `prompts` under the store's `plugins` and pi's `~/.pi/agent/prompts`, a file per command, its description from the frontmatter or the body's first line and its `argument-hint`, its body expanded from the shell-split words after the command (`$1`, `$@`, `${1:-default}`, `${@:N:L}`), offered as session commands |
| `auth.ts` | the keys: the provider's environment variable, else `auth.json` |
| `config.ts`, `paths.ts` | the `harness` section of config.json (`model`, `effort`, `fetchModel`, `compactAt`, `http`, `providers` with their models, prices and thinking kind); where the harness keeps its files, each session's Bash output under `harness/output/<session>` |

Google refuses searches from a fresh headless profile as unusual traffic on some machines. Exa's hosted MCP server (`https://mcp.exa.ai/mcp`) is the keyless backend in the default search order and needs no setup; its queries go to Exa, a third party. `harness.search.order` replaces the default order, so leave `exa` out of it to keep searches off Exa. SearXNG (`docker run -p 8080:8080 searxng/searxng`, with `json` in its `search.formats`) or a key (`widecode --harness-auth brave`, `widecode --harness-auth tavily`, or `BRAVE_API_KEY`, `TAVILY_API_KEY`) searches without Google's refusal. An `EXA_API_KEY`, or an `exa` entry kept with `widecode --harness-auth exa`, is optional.

## The benchmark

`bench/` measures agents on real models: twenty tasks: eight small ones, eight that test what a harness does (a precise edit in a long file, a test's noisy output, a misleading stack, a change across six callers, a value traced through config, existing tests kept green, a tab-indented file, a bug seen only by running the program), and four that need the web (facts published after the models' training, one found through another, and a module brought up to date from them; `"web": true` in their task.json). Every agent searches through Exa's hosted MCP server: the harness's WebSearch, opencode's websearch (`OPENCODE_ENABLE_EXA=1`), and pi through an `mcp.json` in its agent folder naming the server with its tools declared directly (`bench/tasks/<name>/`: a repository, a
prompt, a check the agent never sees, and a solution the test checks the check against), so the
harness, opencode and the DeepSeek Harness run over ACP and pi over its RPC mode. A run copies the
task into a temp git repository, starts the agent there, chooses the model and effort (through the
session's options over ACP, through pi's arguments), sends the prompt, follows the turn (cancelled
past the task's time), runs the check, and deletes the session.

`--agent` takes a list (`--agent harness,opencode,pi`), each agent started as its own command. The
runs go repeat by repeat, task by task, model by model, agent by agent, so a provider's slow hour
falls on every agent alike. One records file holds the whole invocation and its default name joins
the agents with `+`; `--budget` counts all of their runs. `--web` runs only the tasks whose
task.json says `"web": true`, and `--no-web` only the others.

Each harness run gets a fresh temp store passed as `--harness-home`, so the user's skills, prompt
templates, extensions, plugins, MCP servers and config.json never reach the agent. The temp store's
`auth.json` is a symbolic link to `~/.widecode/auth.json`, so the key is linked rather than copied
or read. When the user has skills or prompt templates under HOME (`~/.agents/skills`,
`~/.claude/skills`, pi's agent folder), the daemon also runs with HOME set to an empty temp folder,
PATH and the rest of the environment kept. The temp folders are deleted after the run.
`--user-store` runs the harness over the user's store instead, for a comparison. pi starts with a
folder of its own (`PI_CODING_AGENT_DIR`, so the user's settings and extensions do not load) and
its key read from `~/.widecode/auth.json`. opencode reads its configuration from
`$XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`), so each run gets an empty temp config
folder there: the user's instructions, MCP servers, agents and providers never reach it. Its data
folder is left as it is, since `opencode export` and `opencode session delete` must find the
session, and both run with the same environment as the agent. `--user-store` keeps the user's
config for opencode too.

It records the time to the first token and in all, the calls by tool and those that failed, the
tokens, the context and the cost the agent reported; the records go to `bench/results/` (ignored by
git) and a table is printed. A run that never gets to send the prompt (the agent did not start,
initialize or session/new failed or timed out, the model or effort could not be chosen, or pi
exited or answered nothing before the prompt) is marked `setupFailed`: it is no task failure, so
the table leaves it out of passed/runs and every mean and counts it in a setup failures column.
`--retries <n>` (default 1) runs a setup-failed run again up to n times and keeps the last record.

The record also carries what the agent's stream shows about how a run went: the context the first
request reported, the number of requests (an ACP usage update whose context changed, a compaction's
update and one that only adds a subagent's cost not counted), whether the context was compacted (a
smaller context after a larger one, or unknown when the agent reports none), and the peak context.
pi gives these in each assistant message's usage, then its `get_session_stats` answer gives the run's cost.
opencode's ACP result carries only part of the run's usage, so before its session is deleted the
runner runs `opencode export <session>` and takes the exact per-request tokens and costs from it
(the input there includes the cache). A field an agent does not report is `-1`. The cost is computed
from a price table of dollars per million tokens, `[input, output, cacheRead]`, applied to the input
tokens with those the agent says it read from the cache (ACP's `cachedReadTokens` or a message's
`cacheRead`) at the cache's price, read from `--prices <file.json>` (`{ "<model>": [input, output, cacheRead] }`, under `models` or at
the top) or by default from the harness's model registry: its built-in models and those config.json
adds, each keyed `provider/id`. Both the computed cost and the agent-reported one are kept, and the
table shows the computed one when a price is known.

Every run also writes a transcript beside the records. For `--out <dir>/<name>.jsonl`, the folder
`<dir>/<name>/` holds `<task>-<agent>-<k>.jsonl`, k counting that task and agent's runs in the
invocation, and the record's `transcript` names the file. Its first line is the run: task, agent,
model, whether the task needs the web, whether it passed, whether it was a setup failure. Then a
line per tool call: its number, the agent's own tool name, its category among read, write, edit,
bash, grep, glob, ls, search, fetch, task and other, the path it names (relative to the run's
folder when inside it), a bash call's command, its input cut to 2000 characters, whether it failed,
the length and the first 300 characters of its result, and its time from the run's start. A line
per assistant text follows, cut to 1000 characters. The harness and opencode give these over ACP
and pi in its tool records; opencode's calls come from the `opencode export` when it parses.

```
node src/harness/bench/run.ts --agent harness,opencode,pi --model deepseek/deepseek-flash,opencode/kimi-k2.6 --repeat 2 --budget 1
node src/harness/bench/run.ts --agent opencode --model opencode/big-pickle --tasks fix-bug,edit-json
node src/harness/bench/run.ts --agent pi --model opencode/deepseek-v4.1-flash --tasks fix-bug,edit-json
node src/harness/bench/run.ts --user-store --model deepseek/deepseek-flash --tasks fix-bug
node src/harness/bench/run.ts --report src/harness/bench/results/*.jsonl
```

The summary table has a row per agent and model, its passed runs and run count (`3/5` against
`5/5`), its setup failures, the mean diagnosis fields, and the computed and reported costs, then a
task matrix. For
every model more than one agent ran, a paired table follows: one column per agent with its
passed/runs per task, one column for each other agent's pass rate minus the baseline's (the agent
named `harness`, else the first by name), and a total row. That is the parity view: where two agents
on the same model diverge, task by task.

It talks to real models and spends real money; `--budget` stops starting runs once the cost passes
it. `test/harness-bench.test.ts` runs it on the fake model.

The entry in config.json is a default of the ACP plugin, chosen with `"agent": "harness"` or `--agent harness`. A key: `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY` in the environment, or `widecode --harness-auth deepseek` with the key on stdin. Tests: `test/harness-*.test.ts` (the ACP framing, the agent over the fake model with a tool batch, its session file, a load in another process and a resume, the Anthropic request and its events, the HTTP stream by both ways against `test/harness/fake-model.mjs`, the tools over a temp folder, the session store and the replay, the registry, costs and keys); the app's `test/harness-agent.test.ts` drives the daemon under node as the fake agent is driven, the Sessions tab and a side question's fork included.

## The orchestration benchmark

`bench/orchestrate/` measures orchestrators rather than single runs. An orchestrator (the harness, or
Claude Code) is the main agent of a task made of several independent parts. Each part is one of the
single-agent benchmark's tasks, copied into a subfolder of its own so the parts never collide. The
task's prompt says what each folder needs; it does not say how to delegate. The run's
`.widecode/prompt.md` is the same for every orchestrator: do the work through Task subagents on the
configured target, give each a self-contained brief, start independent ones with
`run_in_background`, review their diffs and run the checks yourself, commit nothing. The store's
`config.json` sets the target (an ACP agent and model, `deepseek` on opencode by default) and
`replaceClaudeSubagents`, so Claude Code and the harness both delegate through widecode's
`mcp__widecode__Task`.

Each run gets a fresh temp folder (each part's repository in a subfolder, one git commit) and a fresh
temp store. `auth.json` is a symbolic link to `~/.widecode/auth.json`, never read or copied;
`trusted.json` names the folder; `config.json` carries the orchestrator, the harness's model and the
Task target. dist/widecode starts in the folder through `test/drive.py`'s App, driven by
`drive_bridge.py`, the prompt is pasted and sent, and the run is followed until the app's log shows a
turn ended, no background subagent is still out and nothing has changed for 30 seconds, or the
task's time runs out. The screen is read once at the end. Then the app is closed and each part's
`check.mjs` runs in its subfolder.

```
node src/harness/bench/orchestrate/run.mjs --orchestrator harness,claude --model <model> --tasks <names> --repeat 2
node src/harness/bench/orchestrate/run.ts --report src/harness/bench/orchestrate/results/*.jsonl
```

The five tasks are `easy-two` (`add-flag`, `edit-json`), `medium-three` (`fix-bug`,
`implement-slug`, `limit-concurrency`), `mixed-four` (`csv-quotes`, `rename-symbol`,
`keep-tests-green`, `trace-config`), `cross-folder` (`answer-from-code`, then `edit-json`, which
reads the port the first writes) and `web-and-code` (`search-release-date`, `edit-json`). A task
passes when every part's check passes; each part's verdict is kept.

The done signal is the app's log: `turn started` and `turn ended` are the conversation's state, and
the acp plugin notes `background subagent <id> finished` or `failed` when a background Task run
reports. The session file names the background ids the Task calls started (`subagent started: <id>`);
a run is done only when every one of those has a finish line, no turn is open, and 30 seconds pass
without a change. Log quiet alone would end a run while a silent subagent still worked.

The record carries:

- passed, and each part's verdict and check output.
- the wall time, from sending the prompt to the done signal or the timeout.
- the orchestrator's requests, input, output and cache tokens and cost. For the harness these are the
  usage entries in `<store>/harness/sessions/<folder>/<id>.jsonl` (the session file). For Claude Code
  they are its own transcript under `<projects>/<folder, non-alphanumerics as '-'>/<id>.jsonl`: each
  assistant message's `usage`, and the result events' `total_cost_usd`, whose per-process totals are
  summed as deltas. Subagent records (`parent_tool_use_id`) are left out.
- the orchestrator's own `Edit` and `Write` calls (work it did instead of delegating) and its `Task`
  calls, with how many ran in the background, read from the same session or transcript.
- each subagent's cost and tokens. Subagents run on an opencode target, which keeps a session per
  run; `opencode session list --format json` finds those whose directory is the run's folder and that
  started during the run, and `opencode export <id>` gives each one's per-request tokens and cost.
- the orchestrator's cost plus the subagents' cost as the total, and the paths of the session file,
  app log and screen dump copied beside the record.

Claude Code runs on the user's login and subscription through its CLI. The harness spends its own
key, read from the user's `auth.json` through the link, as the single-agent benchmark does. The
driver talks to real models: `--keep` leaves a run's folder and store to inspect. The commands that
need no model are tested: `test/harness-bench-orchestrate.test.ts` covers the task loader, repo
assembly, every check before and after its solution, the measure readers on fake session and export
files, the done-signal reader on a sample log, the record round trip and the report. The pty run
itself needs dist/widecode and a real orchestrator, so it is not tested.
