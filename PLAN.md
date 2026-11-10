# Plan

The remaining work from the architecture review, as of commit `8af5202`. This is a backlog, not a
queue: it records what is worth doing and in what order, not a promise to do all of it. Work one
milestone at a time, in small slices.

## How to use this

- Pick the first unchecked box of the current milestone.
- Keep a slice to one subsystem and one commit. A slice is done when its tests are in the same
  commit.
- Before starting, read the milestone again. Another session may have changed the tree, and file
  references are starting points, not guarantees.
- Run `light-native check --all` and `light-native typecheck --all`, then the affected tests under node and natively.
  Native runs need a writable compiler cache (`SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-widecode`), or the
  read-only default prints a `chmod` warning and `light-native test` reports a false mismatch.
- After a slice lands, check the boxes and add a line under Log with the commit and what changed.

## Done

- [x] A folder switch drops the previous project's plugins, re-watches, rebinds the new harness and
      applies its config when trusted.
- [x] `--trust` puts the harness in use after start, including `--trust --ephemeral`.
- [x] The chosen agent carries over a folder switch when the new folder brings it.
- [x] A retired agent plugin falls back to Claude (or a base agent that reports it has none).
- [x] `Hook.fire()` skips a listener removed during the same pass.
- [x] A plugin check takes the prelude from the runtime, removing the
      `api/plugins -> prelude -> namespaces -> api/plugins` import cycle.
- [x] Tests: `folder-switch`, `trust-run`, `agent-removal`, `agent-folder`, and the hook case in
      `packages/kernel/test/kernel.test.ts`.
- [x] Full widecode node suite passes (49 tests), typecheck and check pass for every member,
      `light-native coverage --apps` passes.

Commit: `8af5202 widecode: a folder switch carries its plugins and harness, and a retired agent falls back`.

## Milestone A: data safety and cheap hardening

Small, isolated changes. Each one removes a way a run can lose data or fail silently.

- [x] **`writeAtomic` uses one temp path.** Two widecode processes can clobber each other's
      `<path>.tmp`. Use pid plus counter, and unlink the temp on failure. (`packages/lib/fs.ts`)
- [x] **The log can take startup down.** `openLog` and `log` call `appendFileSync` unguarded. A bad
      `--log` path throws at startup, and a later write throws from arbitrary code. Catch, disable
      the log, report once. (`packages/lib/log.ts`)
- [x] **Process stderr is uncapped and timeouts do not escalate.** Cap stderr with the same budget
      as stdout and mark truncation. On timeout, send SIGTERM, then SIGKILL after a grace period.
      (`packages/lib/process.ts`)
- [x] **Quit drops pending session records.** Await `records.settled()`, stop the watchers, close
      MCP, then exit. (`apps/widecode/src/main.ts`, `src/services/sessions.ts`)
- [x] **A failed session save leaves a stale pending record.** Remove the pending entry on the
      error path, or mark it failed. (`apps/widecode/src/services/sessions.ts`)
- [x] **Config migration loses top-level keys.** A pre-plugins `config.json` is rewritten through
      `configText`, which keeps only `clipboard` and `plugins`; `columns`, `permissions`, `agent`
      and `keymap` vanish. Preserve them, or rewrite only the `plugins` section.
      (`apps/widecode/src/services/store.ts`)
- [x] **`migrateFrom` deletes records it did not move.** Invalid JSON or a missing project folder is
      skipped, then `rmSync(oldRoot)` removes it. Keep the old folder, or move only what succeeded.
      (`apps/widecode/src/services/store.ts`)
- [x] **Tests for the file, log and process fixes, and both migrations.** `packages/lib/test/io.test.ts`
      covers the unique temp, cleanup, stderr cap, timeout and a valid log;
      `apps/widecode/test/store.test.ts` covers the preserved keys and the record left behind.
- [x] **A direct test for a log path that cannot be opened.** A node-only child process keeps the
      stderr warning out of the test runner's output comparison.
- [x] **A direct test for the quit flush.** `quit.test.ts` checks that the exit callback waits for
      the records to settle; the process exit itself stays out of the test.

## Milestone B: conversation and view correctness

The model is the heart of the app and the package has the thinnest direct tests. Add them with the
fixes.

- [x] **The render cache misses parent updates.** A child change bumps its ancestors' revisions, so
      a card drawn from its children redraws. (`packages/conversation/model.ts`, `render.ts`)
- [x] **Orphan events open phantom turns.** `ChatModel.container()` returns null for an unknown
      non-empty parent, and the event is dropped.
- [x] **Requests are not deduped.** A repeated id is the same request within its turn, and a new
      turn gets a new request. The fake CLI reuses ids across turns, which made the panel stay shut.
- [x] **`take`, `takeCommand` and `info` do not bump.** Each mutation bumps the model now.
- [x] **`applyEvents` counts unknown event objects as applied.** It counts the types the model
      knows.
- [x] **The model never prunes.** The newest 1000 turns are kept (`earlier` says the store has
      more), and the tool, task, request and aside lookup maps are capped.
- [x] **`loadEarlier()` relies on the adapter resetting the model.** `Conversation` puts a fresh
      model in place, asks the adapter, and restores the old one on false or failure.
- [x] **Three call-state implementations disagree.** `callState` reads a task's report before the
      result; `agentStatus` and the row's mark use it. (`calls.ts`, `agents.ts`, `render.ts`)
- [x] **`ChatSource` fabricates a Turn to draw the first queued message.** It draws the text and
      image count directly. (`packages/chat/chat-pane.ts`)
- [x] **Path completion scans and sorts the whole folder per keystroke.** It keeps the best `max`
      while it walks. (`packages/chat/suggest.ts`)
- [x] **`loadCommitFile` lacks the `insidePath` guard.** It has the same containment check as
      `loadCode`. (`packages/code/diff.ts`)
- [x] **Tab expansion is not grapheme-aware.** `expandTabs` lives in `ui/text.ts`, counts cells,
      and is used by the code loader, the conversation's cards and markdown.
- [x] **Markdown fenced lines are never clipped, and table backtick handling splits double-backtick
      spans.** A long fence line is clipped with an ellipsis, and a backtick run is tracked.
      (`packages/markdown`)
- [x] **`--trust` still lets first-run onboarding ask questions.** It skips the first-run
      questions, as its comment says. (`apps/widecode/src/main.ts`)
- [x] **Conversation package tests.** `model.test.ts` covers the render cache, an unknown parent, a
      repeated request, a request of an earlier turn, a taken message, unknown events and a failed
      task.
- [x] **A chat package test for the first queued message.** `chat/test/source.test.ts` checks that
      two pending messages both show as queued while a turn runs.

## Milestone C: process, watcher and plugin lifecycle

These share the "something went away while a callback was running" theme.

- [x] **`ClaudeAgent` stays running after a spawn error.** One finish path for `error`, closed
      stdin and `close`: the last lines, then one exit. (`packages/agent/claude.ts`)
- [x] **`ClaudeAgent.stop` never escalates.** SIGTERM after the grace period, SIGKILL after
      another; `kill()` sends SIGKILL.
- [x] **`PluginProcess` leaks on ENOENT.** A spawn error finishes the handle once and delivers its
      exit. (`packages/plugins/process.ts`)
- [x] **`PluginProcess` queues lines without a cap.** Waiting output is capped at 2048 lines and the
      plugin is told once when lines are dropped. (`packages/plugins/process.ts`)
- [x] **Watcher loads can reject unhandled.** `FolderController.received` reads through a helper
      that catches and says the failure. (`packages/workspace/folder.ts`)
- [x] **Symlink loops in the file walk and watcher.** `lstat` makes a symlink a file, never a
      directory to descend into. (`workspace/files.ts`, `watch.ts`)
- [x] **`watchDir` swallows `fs.watch` failures.** It warns with the directory.
      (`workspace/watch.ts`)
- [x] **MCP tokens outlive their plugin.** `forgetOwner` removes the token and its config file on
      retire; a full reload keeps tokens so a running agent keeps working. (`runtime.ts`,
      `agent/mcp.ts`)
- [x] **`JsRuntime.errors` grows without bound.** It keeps the last 100. (`runtime.ts`)
- [x] **Claude's history and live lines grow without bound.** Caps of 8000 live lines and 40000
      history lines. (`plugins/claude.ts`)
- [x] **`/open` is not transactional.** It reads the new workspace and makes its conversation
      before closing the old one, refuses a second switch, and catches a failure in the caller.
      (`controllers/host.ts`, `runtime.ts`)
- [x] **`SessionController.open` can prepare an agent that is about to be retired.** The old agent
      is attached but not started; the folder's plugins load, `folderOpened` re-chooses it, and the
      conversation prepares after that.
- [x] **The peers plugin ran whatever program it was in as the daemon.** `ensure()` started
      `process.execPath --peers-daemon`; under the native test runner that is the test binary, which
      ignores the flag and runs the test again, whose app's plugin starts another, each detached by
      `setsid -f`: 875 processes and 16 GB. The launcher is a host field the real entry alone sets
      (never under `--selftest`, never for `createWidecode`), auto-start waits for the bridge to be in
      use here or asked for by the user, and a client starts a daemon at most three times, thirty
      seconds apart. (`api/peers.ts`, `packages/peers/client.ts`, `startup.ts`, `controllers/host.ts`)
- [ ] **Subagents launched from a widecode session stall before their first tool result.** Three
      Explore agents (Claude Code's Agent tool, in the background) each wrote one sentence and ran no
      tool for 42 minutes, took no notice of a message sent to them, and had to be killed. Suspects:
      the subagent event stream (`parent_tool_use_id`, `--forward-subagent-text`) or stdin while a
      subagent runs. Reproduce with one trivial background Agent call, then bisect. (`plugins/claude.ts`,
      `packages/agent`)

## Milestone D: QuickJS execution

Do this after C, because the native tests depend on the process lifecycle being trustworthy.

- [x] **The 250 ms budget is bypassable.** The jobs pump takes one deadline, host time excluded
      from a call is capped at five seconds, and the runtime switches off a plugin whose jobs pass
      the budget. (`packages/plugins/native/wcjs.c`, `runtime.ts`)
- [x] **Unhandled QuickJS rejections are silent.** A rejection tracker keeps the first unhandled
      reason and the jobs pump reports it; the runtime fails the plugin with it.
- [x] **A slow Sessions listing can switch the agent off.** `SESSIONS` gets the two-second history
      budget. A listing that still passes it goes through the normal over-budget retire.
      (`runtime/agent.ts`, `api/sessions.ts`)
- [x] **A circular plugin result silently becomes `null`.** JSON that cannot write a value is a
      plugin error. (`wcjs.c`)
- [x] **Native tests for the loops and the circular result.** `engine.test.ts` runs an
      `await 0` loop, a host-call loop and a circular value under node and natively.
- [x] **An unhandled-rejection test.** A native C driver links `libwcjs.a`, rejects a promise and
      checks `wcjs_jobs` reports it once. The node stand-in is left alone because its event loop
      does not match QuickJS's job pump.

## Milestone E: architecture, runtime and startup

Only after the tree is clean and the full native suite is green. These are high churn and low
user-visible payoff.

- [x] **Split `JsRuntime`, first three stages.** `PluginTable`, `ProcessTable`, `ViewTable` and
      `HostRouter` are out. The loader and reload paths remain in `JsRuntime`; splitting them is an
      optional fourth stage. (`runtime/*.ts`)
- [ ] **Split `Store`, paused.** Trust and limits are out (`services/trust.ts`,
      `services/limits.ts`). Config, state, sessions and migration remain. Do not split further
      until the storage design below decides whether these become models.
- [x] **Move `main.start()` into a startup pipeline.** `main.ts` keeps the flags, log, signals and
      terminal checks; `startup.ts` owns the workspace, compose, commands, app wiring, onboarding,
      resume and selftest. (`main.ts`, `startup.ts`)
- [x] **Centralize core command registration.** `commands.ts` holds the shell and store commands;
      `Widecode.start` registers the first and startup the second. Widget-local key bindings stay
      with their widgets.
- [x] **Decide whether tab columns are open or closed.** Closed: `widecode.d.ts` types a panel's
      `column` as `"side" | "tools"`, `api.ui` defaults anything else to `"side"`, and the shell
      renders those two. A third tab column needs a deliberate change.
- [x] **One API dispatch registry.** `namespaces.ts` holds one entry per namespace group with its
      answer; the runtime walks it, and `api.test.ts` checks every namespace with a case is routed.
- [x] **Generate function slots from one table.** `runtime/slots.ts` names the panel and agent
      slots; the runtime derives its indexes and widths from it, and `api.test.ts` checks the
      prelude passes exactly that order.
- [x] **Bind the owner id in the prelude.** The api appends its registration to every call; the
      router rejects a direct `__host` call from a running plugin and checks the owner first on the
      registration calls that use one.

## Milestone F: kernel and API boundaries

- [x] **Move Claude-specific logic out of the core.** The CLI lookup is in the Claude plugin and
      the title writer is in `@widecode/agent`, the Claude sidecar. The fixed prompt stays Claude-only
      because the ACP plugin does not pass a system prompt.
- [x] **Keep `StatusInfo` agent-neutral.** The status line's data and its JSON now live in
      `@widecode/agent/status-info.ts`, the Claude sidecar; `@widecode/conversation/status-info.ts` only
      re-exports it for the views and plugins that hold it.
- [x] **Fix the two `any`s in `widecode.d.ts`.** `StatusInfo` types the status line input for a
      segment and `state.info()`.
- [x] **Make `Keyed.put` reversible.** A replacement's removal restores the item it replaced.
      (`kernel/registry.ts`)
- [x] **Guard plugin activation and lifecycle.** `activate()` is guarded, `start()` stops what it
      started, and `remove(id)` stops the plugins that require it. (`kernel/kernel.ts`)
- [x] **Reset `Settings.notice` on `load`, and record invalid plugin values.**
      (`kernel/settings.ts`)
- [x] **Reject or replace duplicate column and panel ids.** A later column, tab or band part of the
      same id replaces the earlier; `chosen` is pruned. (`screen/screen.ts`)

## Milestone G: extraction and guardrails

Do these when a slice already touches the files, not as a separate rewrite.

- [x] **Move `Hook` to `@light/lib`.** It is a generic owner-scoped listener list;
      `@light/workspace` no longer depends on the kernel.
- [x] **Finish the JSON narrowing helpers in `lib/json.ts`.** `str`, `strs`, `listOf` and
      `parseJson` are shared; `api/values.ts`, the conversation events and the code views use them.
- [x] **Expose those helpers in the plugin prelude `util`.** `str`, `num`, `list`, `strs`, `obj`,
      `parse`, `quote`, `wrap` and `throttle` are in. The specialized readers in `models` and
      `status` stay because they match those plugins' own sections and ANSI lines.
- [x] **Put `SessionMeta` marshalling in one place.** `SessionMeta.of` and `toRow` own the store's
      field list. The `store.session` answer still builds its own JSON.
- [x] **Extract one tool-head renderer.** `toolSummary` is the one summary; `callPage` and
      `tools-pane` call it instead of rebuilding the line.
- [x] **Generate the language table once.** `packages/highlight/languages.ts` is canonical;
      `scripts/builtin-plugins.mjs` fills the languages plugin's list from it at build time.
- [x] **Move the highlight string readers into `stream.ts`.** JavaScript and CSS share `readString`;
      HTML's `readUntil` stays local because it does not read escapes.
- [x] **Reuse free function ids in the prelude.** Retired and once-only slots go on a free list and
      are reused. (`packages/plugins/prelude.ts`)
- [x] **Enable `noUnusedLocals` and `noUnusedParameters`.** Every member compiles with both.
- [x] **Clean stale comments.** They point at the files that exist now.
- [x] **Replace the em dash in `conversation/render.ts`.**
- [x] **Add a lint or format step.** `scripts/lint.sh` checks app/package text for em dashes and
      `any` types; the compiler now catches unused locals and parameters.
- [x] **Add CI.** `scripts/ci.sh` runs lint, check, typecheck, every test under node and natively
      with a writable `SCRIPTC_CACHE_DIR`, coverage, and the three widecode selftests.

## Milestone H: performance and test coverage

Measure before changing a performance path.

- [x] **Stop statting every changed file per `changes()` call.** Mtimes are cached between status
      loads. (`workspace/changes.ts`, `folder.ts`)
- [x] **Stop rebuilding the tree on every status load.** Unchanged marks keep the previous map, so the
      tree's identity check holds. (`workspace/folder.ts`)
- [x] **Give `loadFiles` latest-wins coalescing.** A stale file read is dropped.
- [x] **Stop listing files twice at startup and `/open`.** `openWorkspace` hands its listing to the
      first `files()` call.
- [x] **Read branch and status in one git run.** `status --porcelain=v1 --branch -z` carries the
      branch header; a detached HEAD still asks `rev-parse`. (`workspace/git.ts`)
- [x] **Bound the ACP Myers diff.** `MAX_EDITS` is 500; past it the edit is whole-file.
      (`plugins/acp.ts`)
- [x] **Cap status-command output.** At most sixteen lines are parsed. (`plugins/status.ts`)
- [x] **Cap prompt history files and entries.** Older files are capped at ten and a step parses at
      most 5000 lines of one. (`conversation/history.ts`)
- [x] **Bound the Git plugin's commit-file cache.** At most 32 opened commits are kept.
      (`plugins/git.ts`)
- [x] **Package tests for `screen` and `chat`.** Screen has a registry test; chat has `suggest`.
- [x] **`ui` tests for `wrap`, `clipText` and durations.** `text.test.ts` and `duration.test.ts`
      cover them.
- [x] **`agent` tests for `ClaudeAgent` start, error, exit and stop, and MCP auth and config files.**
      Start, error, exit and stop are covered; the MCP files are covered in the app's `mcp.test.ts`.
- [x] **`markdown` tests for inline, fences, headings and lists.** An unclosed fence is still
      open.
- [x] **`plugins` tests for `sources.ts` and the node stand-in's budget differences.** `sources.ts`
      and the stand-in's four-budget allowance are covered.
- [x] **App tests for the config migration preserving every key, and the quit flush.** Migration
      preserves every key; the quit flush order is covered by `quit.test.ts`.

## Milestone I: peers, the LAN git bridge

The machines on one network share repositories with each other, fetch-first, no hub (`packages/peers`, the `peers` plugin, `README.md` "Peers").

- [x] **The bridge's core.** A machine's identity (ed25519, the id its key's SHA-256), the registry (peers with mutual tokens, shares by root commit with a branch filter and an allow list), pairing by a six-digit code and an HMAC proof, the smart HTTP server piping `upload-pack --stateless-rpc` (and `receive-pack` for hosted repositories), one daemon per machine with a loopback control API and a state file, `widecode --peers-daemon`. (`eaf2190`)
- [x] **The Peers tab, the segment, the namespace.** `api.peers` (`ensure`, `request`, `share`, `remote`, `fetch`, `remotes`); a peer's copy matched by root commit becomes a remote named after it, its token in the local git config; auto-fetch keeps ahead and behind live. (`180bc46`)
- [x] **Discovery, and the daemon started by the real app alone.** mDNS through avahi and dns-sd, nearby machines joinable by name; the launcher a host field only `startWidecode` sets, auto-start only when the bridge is in use or asked for, at most three starts thirty seconds apart. (`701e0a6`)
- [x] **The Git tab's peers.** The paired peers with a remote here, their branches against ours, Enter for their log, the `peer` compare base, the badge. (`2f1b796`)
- [x] **Hosted repositories.** `/peers host <name>` makes a bare repository under the store that paired peers push into; empty until the first push gives it its id.
- [x] **The machine's repositories against each peer's.** The daemon owns the fetching (`sync.ts`): for each peer it reads the offers, matches each to a live share here by root commit, sets the peer's copy up as a remote named after the peer in that checkout (the token in its config), fetches, and counts the checkout's current branch against theirs, keeping the commits new over there; every two minutes while the peer is online, after a pairing, and when a session asks (`/api/peer/sync`, one offer at a time by key). `/api/clone` brings an offer this machine lacks and shares it. The tab lists every repository under its peer with ↓, ↑, level, not here or hosted, the hint row says what the keys do for the row under the cursor, and a repository's page lists the commits to fetch with the merge or rebase that takes them; `c` and `/peers clone` clone. The namespace lost `remote` and `fetch` (the daemon's job now) and gained `clone`.
- [ ] **Later.** TLS pinned by peer id; an in-process mDNS responder over dgram; a push from the tab; the daemon as a login item.
- [x] **The native `fetch` failed against a peer's daemon for minutes while curl reached it.** Seen three times on the Mac: a daemon's requests to the Linux daemon answered `fetch failed` for a stretch; a fresh native process looping every ten seconds failed from its first attempt for 150 s against one Linux daemon instance (loopback fine throughout, curl from the same Mac fine against the same instance), then every variant (no headers, `Connection: close`, another header) succeeded against the next instance. Not pooling, not the header, not process age. Daemon-to-peer requests go through the curl binary now (`peer-request.ts`), one process and one connection per request, which git uses for the same peers anyway. For the fork: a native `fetch` to a LAN host that curl reaches, failing without detail. (`packages/peers/peer-request.ts`)

## Milestone J: the harness, widecode's own agent

A coding agent of widecode's own, in pi's spirit: a daemon of the binary (`widecode --harness`)
speaking ACP on stdio to the acp plugin, talking to model APIs directly (the Anthropic Messages
API first, which DeepSeek serves too), running its own tools without approvals (pi's posture;
plan mode is read-only), keeping JSONL sessions, reading the web through headless Chromium
(`packages/harness`, the `harness` entry of the acp plugin, README.md "The harness"). The whole
design is the plan approved on 2026-10-25 (the architecture, the ACP contract, the decisions, the
risks); each slice below is one commit with its tests.

- [x] **The skeleton and the entry.** `packages/harness` as a member; `AcpServer` (stdin lines,
      ids echoed, requests out, a trace file) and `AcpAgent` (initialize, session/new, load and
      resume of a session the process holds, fork, prompt with steering, cancel, set_config_option,
      list); `Message`/`Part`; `ModelClient` with the `FakeClient` scripted from a JSONL fixture; a
      text-only turn in `AgentLoop`; the base system prompt with the project's text from
      `_meta.widecode`; `widecode --harness` dispatched in `main.ts` with its own log folder and
      crash monitor; the acp plugin's `harness` entry with `{widecode}`, `own` and `_meta`. Tests:
      `acp-server.test.ts`, `agent.test.ts`, `imports.test.ts`; `apps/widecode/test/harness-agent.test.ts`.
- [x] **The Anthropic client, Read and Bash.** `SseSplitter`, `HttpStream` with `node` and `curl`,
      the Anthropic request (cache breakpoints, thinking and effort by model, usage), the registry
      with the Anthropic and DeepSeek rows and prices, `costUsd`, `Auth` and `--harness-auth`,
      `--harness-models`, the config's providers; `Tool`, `Read`, `Bash` with the capped child
      runner; batches (one at a time when a call mutates); `tool_call` updates; `usage_update`
      with the cost; cancel; retries on 429, 529 and server errors. Tests: `sse`, `anthropic`
      (the request's text, the events read), `http-stream` (both ways against
      `test/fake-model.mjs`, the client end to end with a retry and a refused key), `tools`,
      `registry`; the app test's tool-calling turn. Open: the live probe of both HTTP paths
      (`test/probe/model.mjs`, `NATIVE_LIVE=1` with a key) decides the default.
- [x] **Edits and search.** `patch.ts` (the Myers line diff and the unified patch), `Write` and
      `Edit` (a file read first, the mode and line endings kept, the change as a diff block and
      `filediff.patch` the code column follows), `glob-match.ts`, `Grep` (ripgrep or grep), `Glob`
      (the workspace's file list), `LS`. Tests: `patch`, `glob-match`, `edit`, `tools`; the app
      test's edit turn. The second slice's live probe ran: DeepSeek's streams are recorded under
      `test/fixtures` and read by `anthropic.test.ts`; the installed binary ran a real turn with
      Read and Bash over the node HTTP path natively, which stays the default.
- [x] **Modes and the tool set.** `build` and `plan` as the mode option, `current_mode_update`,
      the read-only set in plan, `--harness-tools <mode>` answered from the set (done with the
      earlier slices; the app test covers /plan and the Available tab in both modes).
- [x] **Sessions.** The JSONL tree, replay on load, resume, fork as a file, `--harness-sessions`,
      `--harness-forget`, titles and `/title` (the acp plugin takes `/title` over for an agent whose
      session commands include it; a tool result keeps its outcome for the replay; a batch cut off
      by the process's end gets error results on load).
- [x] **Compaction.** The estimate, the threshold and `compactAt`, the summary, `/compact` (a
      compaction entry in the session file; a load starts the context at its first kept message).
- [x] **Skills, context files and widecode's tools.** The skills scan, the `Skill` tool, AGENTS.md
      and CLAUDE.md, `--harness-skills`; widecode's MCP tools called over HTTP (AskUser's question
      in the request panel from the harness; the date and plan mode's note in an uncached block).
- [x] **The web.** `browser.ts`, `WebFetch` through headless Chromium with the curl fallback,
      `html.ts`, `WebSearch` with the chain (searxng, google, brave, tavily; duckduckgo opt-in).
      Google refuses a fresh headless profile as unusual traffic from this machine (October 2026),
      so a search here needs SearXNG or a key; Anthropic's server-side search is left for later.
- [x] **The selftest and the docs.** The `harness` selftest, README.md "The harness",
      `light-native coverage --apps` with the daemon's code (static). PLUGINS.md keeps "The
      harness" as the folder's heading, which AGENTS.md and the docs the binary carries name.
- [x] **The OpenAI-compatible client and OpenCode Zen.** `model/openai.ts` (chat completions, tool
      messages, `reasoning_content` sent back), a model's own API and base URL, Zen built in (Claude
      on its Anthropic-format endpoint, the rest on its chat completions one). A live run on
      DeepSeek's chat endpoint found the Grep and Glob schemas sent as invalid JSON since the
      edits slice (an escaped quote lost in a single-quoted string); fixed, with a test that every
      schema parses.
- [x] **A benchmark.** `bench/`: eight tasks with hidden checks and solutions, a runner over ACP
      (any ACP agent, the model and effort through the session's options), JSONL records and a
      table. First live run: the harness passed all eight on DeepSeek Flash and V4 Pro; opencode's
      free DeepSeek V4.1 Flash passed five of six.
- [x] **A deny list.** `permissions.deny` of the user's config.json and a trusted project's, in
      Claude Code's syntax, checked before a call runs; the tools listing marks a tool denied whole.
- [x] **Subagents.** A `Task` tool: a nested loop with the tools but Task, its report the result,
      its cost counted; the acp plugin draws it as an agent.
- [x] **Images.** A prompt's images and a Read of an image file, for a model that reads them
      (`vision`); to Anthropic as content blocks, to a chat completions API as a user message.

Pending, roughly in order of value (October 2026):

- [ ] **Keyless web search.** Google refuses a fresh headless browser's queries as unusual traffic
      from this machine (both the headless shell and Chromium's new headless mode, two queries), so
      WebSearch works here only with SearXNG or a Brave or Tavily key. pi's `pi-web-access` gets
      keyless search from Exa's hosted MCP endpoint; the harness has the MCP client to call it. Add
      it as a backend before Google in the default order (queries go to a third party: say so in
      the README; check its keyless rate limits), and Jina Reader as WebFetch's fallback for a page
      that blocks the browser.
- [ ] **Google, best effort.** Keep it out of the default order, or try what lowers detection: a
      persistent profile under the store keeping Google's cookies, `--disable-blink-features=
      AutomationControlled`, a headed browser under a virtual display. Few queries while trying:
      the network's reputation counts.
- [ ] **Anthropic's server-side web search** as a backend when the model is Anthropic's: the
      `web_search` server tool in the request, its result blocks kept and replayed as a fetch call.
- [ ] **A screenshot from WebFetch.** Chromium's one-shot `--screenshot` with a window size, the image
      attached for a model that reads images (the images slice carries it).
- [ ] **MCP servers in config for the harness.** `harness.mcpServers` beside the client's: HTTP first
      (`McpLink` exists), then stdio (spawn, JSON-RPC per line). This gives a stateful browser at once
      through Playwright's server (`npx @playwright/mcp --port 8931`), at the cost of Node and the
      package on the machine.
- [ ] **A native stateful browser tool**, for driving the user's own web app. First a probe: a
      WebSocket client natively (scriptc lowers the HTTP client's `upgrade` event, per its source;
      `--remote-debugging-pipe` is out, the runtime hands a child no extra descriptors). Then a
      DevTools client (ids, events, a session per tab), the browser's lifetime per session (started
      on first use, closed with the session, restarted after a crash, a fresh profile by default),
      the actions in Playwright MCP's shape (navigate, back, a snapshot of the accessibility tree
      with refs, click and type by ref, keys, select, scroll, wait for text, evaluate, screenshot,
      tabs), the guards (deny rules by domain, mutating, out of plan mode), and a test over a local
      page with a form.
- [x] **OpenCode Zen, live.** Its Anthropic endpoint takes `x-api-key` and Anthropic's extras (a
      second request read 5,902 tokens from the cache); a key is served the models its account has
      enabled (44 of 90), the others refused, four of the earlier rows among them; the lineup is
      the enabled ones checked with a tool, prices from opencode's list, the cost Zen reports per
      request used. The benchmark, one run of each task: all 48 passed on Claude Haiku 5.5 ($0.016
      in all, 11.5 s a task), DeepSeek V4.1 Flash ($0.030, 8.6 s), GLM 5.3 Flash ($0.020, 18.6 s),
      Qwen 3.8 Flash ($0.024, 51.1 s), MiniMax M3 ($0.057, 20.8 s), Kimi K3 ($0.307, 63.1 s; its
      add-flag run passed its check but its turn ran past the task's 240 s).
- [ ] **A long call's progress to the client.** The loop hears a Bash call's output as it comes and a
      subagent's calls, but the agent does not forward `onToolOutput`: send them as
      `tool_call_update` content while the call runs.
- [ ] **The benchmark, further.** Harder tasks (both DeepSeek models pass all eight), more repeats, a
      Claude Code driver over stream-json (it runs on the user's subscription: the user's call),
      opencode's cost from its `usage_update` since its prompt answer reports part of its usage.
- [ ] **Branching from an earlier entry** of a session (the file's tree has it; the UI has no way to
      ask for it yet).
- [ ] **The native `fetch` behind `HttpStream`**, once a streaming probe passes.
- [ ] **Prices refreshed** from the providers (most of Zen's are unknown, so its cost shows as none).

## Milestone K: pi as an agent, and plugins that reach the harness's loop

pi (badlogic/pi-mono, `@earendil-works/pi-coding-agent` 1.5.1 as of 2026-11-10) loads extensions
as TypeScript modules through jiti in Node: `export default function (pi: ExtensionAPI)`, about
forty events (`tool_call` may block or patch a call, `tool_result` replace its content, `context`
rewrite the messages, `before_agent_start` the system prompt), tools with JSON Schema parameters,
commands, `pi.exec`, `appendEntry`, and `ctx.ui` (dialogs, notify, status, widgets, pi-tui
components). Every published package read (pi-web-access, pi-cmux, pi-subagents, plannotator)
imports Node builtins and npm packages, so none runs in QuickJS. Three parts follow from that:

1. pi itself as an agent of widecode, over its RPC mode, so every pi extension works as pi runs it.
2. The formats both share without running code: skills (the same Agent Skills format) and prompt
   templates.
3. A plugin system of the harness's own on QuickJS, in pi's shape: the names and signatures of
   pi's API where the harness has the thing, so an extension that needs no Node runs in both, and
   the important ones written again for it.

Where the harness's hooks go (read 2026-11-09): `before_agent_start` and `input` at
`AcpAgent.prompt`/`startTurn`; `context` in `AgentLoop.request` before the `ModelRequest`;
`tool_call` and `tool_result` around `ToolSet.run` in `AgentLoop.batch`; tools through
`LoopSession.extraTools` as MCP's are; commands beside `/compact` and `/title`; session events at
`make`, `restore`, `reopen` and the daemon's end (no per-session close exists); compaction at
`compactContext` and `compactRequested`. Task subagents build a fresh `LoopSession`, so the
registry is handed to them. `AcpServer.sendRequest` exists and nothing calls it; the acp plugin
answers only `session/request_permission`.

- [x] **pi as an agent.** `plugins/pi.ts` over the user's `pi --mode rpc` (never bundled): the
      prompt, steering and abort, the stream's events into `api.conversation.apply`, the models
      and thinking levels as options, the commands, sessions listed and resumed from pi's files;
      `extension_ui_request` mapped: select, confirm, input and editor to the request panel
      (`extension_ui_response`, `cancelled` on a cancel), notify to a notice, setStatus to a
      segment, setWidget's lines to a band strip, setTitle to the session's title. Tests against
      `test/fake-pi.mjs`; a live check with `NATIVE_LIVE=1`.
- [x] **Shared formats.** The harness's skills scan reads pi's folders too (a trusted folder's
      `.pi/skills`, `~/.pi/agent/skills`); prompt templates in pi's format (frontmatter
      `description`, `argument-hint`; `$1`, `$@`, `$ARGUMENTS`, `${1:-default}`, `${@:N}`,
      `${@:N:L}`, shell-like quoting) from `.widecode/prompts`, `.pi/prompts` (trusted),
      `~/.widecode/harness/prompts` and `~/.pi/agent/prompts`, offered as commands and expanded in
      `prompt`. Tests: `prompts.test.ts`, `skills.test.ts`.
- [x] **The engine in the daemon.** `@light/plugins` as a dependency of `@widecode/harness`; an
      extension is a `.js` file in pi's shape (`export default function (pi) {}`, no `import`: a
      load error names the line), from the store's `extensions/` (`~/.widecode/extensions/`, or
      `$WIDECODE_HOME/extensions`) and a trusted folder's `.widecode/extensions/`, beside the
      app's `plugins/` in both (the loader turns `export default` into an assignment the prelude
      reads and drops `export` before a declaration); an engine per folder the sessions use, a
      prelude of the harness's own, the 250 ms budget per call, an extension that throws or runs
      over switched off with a log line.
      The first API: `registerTool` (JSON Schema parameters, `execute(id, params, signal,
      onUpdate, ctx)` answering `{ content, details, isError }`), `registerCommand`, and `on` for
      `session_start`, `before_agent_start`, `context`, `tool_call` and `tool_result`. Tests with
      `// ffi: @light/plugins/native/ffi.json`.
- [x] **The UI over ACP.** First the engine's calls made asynchronous (done: a callback's promise
      settles when the host answers, `hostLater` and `settleHost` for host work, the hooks awaited
      in the loop, a context per call by id; the acp plugin's half is done too). Then `ctx.ui` as an ACP extension request from the harness (`_widecode/ui`,
      through `sendRequest`), answered by the acp plugin the way pi's RPC client answers
      `extension_ui_request`: dialogs to the request panel, notify, setStatus, setWidget lines,
      setTitle; `ctx.hasUI` false for a client that did not say it takes them.
- [x] **An instance per session, and exec.** pi makes a runtime per session, so an extension's
      module state is a session's: the engine stays one per folder and trust, and each session
      evaluates every extension again with a `pi` of its own (its handlers, tools and commands
      the session's; a Task subagent uses its parent's). `pi.exec(command, args, { signal,
      timeout, cwd })` over `proc.ts` answering `{ stdout, stderr, code, killed, truncated }`;
      the test-only sleep replaced by it.
- [x] **Session entries and messages.** `appendEntry` as a `custom` entry kept on load and outside
      the context; `ctx.sessionManager` read-only over the file (pi's entry shapes);
      `setSessionName` and `getSessionName` over the title; `sendUserMessage` and `sendMessage`
      (steer, follow up, next turn, `triggerTurn`); a command or tool registered after the
      session opened announced again.

The direction changed on 2026-11-10. No published pi extension loads here (each imports typebox,
pi's modules or Node), so the harness's API stops calling itself pi's: it keeps pi's design (the
events, what a handler may answer, the tool shape) under widecode's names, and it becomes a part of
a widecode plugin rather than a file kind of its own. A plugin is one definition with two parts:

```js
widecode.plugin({
  id: "permission-gate",
  activate(api) { /* the app: keys, columns, segments, commands, MCP tools for every agent */ },
  agent(agent) { /* the harness's loop: agent.on("tool_call", ...), agent.registerTool(...) */ },
});
```

The app's runtime evaluates the file and runs `activate`; the harness daemon evaluates the same
file in its own engine and runs `agent`. A plugin lives in a folder of its own (`plugins/<id>/`:
`index.js`, its `skills/` and `prompts/`, a README), a single `plugins/<id>.js` still loading.

- [x] **One plugin, two parts.** The harness loads widecode's plugins: the built-in ones (the app
      hands the daemon their sources; the daemon is the same binary), the store's `plugins/` and a
      trusted folder's `.widecode/plugins/`, in the app's order and override rule (an id defined
      again replaces the earlier). Its prelude defines `widecode.plugin`, `widecode.util` and a
      plain `widecode.theme`, runs a definition's `agent(agent)` and ignores the rest; the app's
      prelude ignores `agent`. `plugins.<id>: false` in config.json switches both parts off; the
      agent part reads its section (`agent.settings()`). The `extensions/` folders, the
      `export default` pass (`ext/source.ts`) and the tool-name mapping (`ext/names.ts`) go:
      events carry the harness's own names and inputs (`Bash` with `command`, `Read` with
      `file_path`). Identifiers lose `pi` (`piFor`, `messagesToPi`); the agent API's types go in
      `widecode.d.ts` (`widecode.AgentApi`, `AgentContext`, the events), `test/api.test.ts`
      checking them as it checks the app's.
- [x] **Plugin folders.** `plugins/<id>/index.js` beside `plugins/<id>.js`, in the store, a trusted
      folder and the built-ins (`apps/widecode/plugins/<id>/index.ts`, `scripts/builtin-plugins.mjs`
      walking folders). A folder's `skills/` are the harness's skills and its `prompts/` its
      prompt templates (listed with their plugin as the source); its README is what the Plugins
      view shows. A save anywhere in a folder reloads that plugin alone, in the app and in the
      daemon (its `session_shutdown`, its source again, `session_start` with `reload`), the turn
      going on; a removed folder takes its tools and commands away.
- [x] **The rest of the agent API.** `getActiveTools`, `setActiveTools`, `getAllTools`;
      `setModel` and the thinking level; `agent.events` between a plugin's handlers; the turn,
      agent, model, input, compaction (`session_before_compact` answering a summary),
      `session_before_fork` and shutdown events; `/reload`.
- [ ] **The two parts talk.** `agent.send(type, data)` and `api.agent.on(type, f)` (and back) over
      an ACP notification of the plugin's id, so a plugin's agent part can feed its own view (a
      todo tool and a Todo tab).
- [x] **The important plugins.** Built-in plugins with an agent part, written from pi's examples:
      `permission-gate`, `protected-paths`, `git-checkpoint`, `todo` (its tab too, once the parts
      talk), `inline-bash`, `tools`, `dirty-repo-guard`, `claude-rules`. A test each, switched off
      in a test too.
- [ ] **The docs.** PLUGINS.md's plugin shape and folder, the agent part's API and events, the
      harness README.

## Deferred or skip

- **Storage: files or models.** The durable state is split across file services (`Store`,
  `TrustStore`, `LimitsStore`) and a model-backed store (`SessionRecords` over
  `sessions.jsonl`). The next storage design should decide whether config, state, trust and limits
  become models too, so there is one read, write, watch and settle story. Questions to settle:
  single-object models versus row models, which files are reactive, who owns watching, how
  migration and hand-edited JSON survive, and what stays a path or migration helper. Revisit after
  Milestone E, before splitting `Store` further.
- **Full `JsRuntime` split:** real design debt, high churn, no user-visible payoff. Revisit after
  Milestone E and a clean tree.
- **`StatusInfo` agent-neutrality and the tab-column registry:** decide with a concrete feature need.
- **Desktop tests:** the desktop app is a small separate harness; `@widecode/agent` tests cover more of
  the same code.
- **CI:** worth adding, but it needs a writable compiler cache and a native toolchain. Set it up
  after the correctness milestones.
- **Every performance item:** some are real, some are micro. Measure first.
- **Any item already moved by the concurrent image and ACP work:** re-triage before starting.

## Log

- `a2e1ca1` Milestone K, todo and tools-switch (the session view shows a tool result's name and
  details, a batch's results as entries of their own); `a4b18d0` inline-bash, claude-rules,
  dirty-repo-guard and git-checkpoint (no refs: a checkpoint is a commit kept in the session).
  Tests: one per plugin. `coverage --apps` reported apps/widecode as not static at a4b18d0, the
  sites all in light's model/ and html/ after light's TypeScript 7 commits and scriptc v0.4.11.
- `9529f70` and the next commit, Milestone K, the rest of the agent API; `9ed9c07`
  permission-gate and protected-paths with `test/support/agent-rig.ts`.
- `9557d66` (light `b5f449e`) Milestone K, plugin folders and the built-ins in them; `d1fcc56` a
  plugin folder's skills and prompts in the harness; the daemon's reload on save. Tests:
  `reload`, `skills`, `prompts`, `extensions`.
- `b609283` Milestone K, session entries and messages. `8ca2f9a` the harness runs widecode
  plugins' agent part. `c6bcc82` (light `78d683b`) an agent-only plugin, the agent API's types.
- `819dd73` Milestone K, an instance per session and `pi.exec`. Test: `extensions`.
- `e23ebd0`, `767b9c4` Milestone K, the UI over ACP: calls settle when their promise does,
  `ctx.ui` as `_widecode/ui` requests and notifications. Test: `extensions`.
- `cc701b1` Milestone K, the engine: extensions in pi's shape, tools, commands, five events.
  `276c5bf` the acp plugin's `_widecode/ui`. Tests: `ext-source`, `ext-names`, `extensions`,
  `acp-ui`.
- `102598a` Milestone K, pi as an agent: `plugins/pi.ts` over `pi --mode rpc`, extension UI
  requests to the request panel and the screen. Tests: `pi` against `fake-pi.mjs`.
- `b71864a` Milestone K, shared formats: pi's skills folders, prompt templates in pi's format as
  the harness's session commands. Tests: `prompts`, `skills` (natively too), `agent`.
- `8af5202` Folder switch, `--trust`, retired-agent fallback, hook removal, prelude cycle. Tests:
  `folder-switch`, `trust-run`, `agent-removal`, `agent-folder`, kernel hook case.
- `3a8cce3` Milestone A: unique write temp with cleanup, guarded log, capped stderr and timeout
  escalation, quit flush, pending save cleared on failure, config migration preserving keys,
  `migrateFrom` keeping unmoved records. Tests: `lib/io.test.ts`, `store.test.ts`.
- `fdcf873`, `443c194` Milestone B: the model applies only known events, drops an event it cannot
  place, bumps ancestors for a card's cache, dedupes a request within its turn, and bumps on take
  and info.
- `229ae52` One call state for the views, and `expandTabs` in `ui/text.ts` counting cells. Tests:
  `conversation/model.test.ts`, `ui/text.test.ts`.
- `0ce9aba` Completion keeps the best few, the first queued message is drawn without a Turn,
  `--trust` skips onboarding, the commit-file guard, shared tab stops, markdown clipping and
  double-backtick cells. Tests: `chat/suggest.test.ts`, `code/diff.test.ts`,
  `markdown.test.ts`.
- `70f829f` A request id is new again in the next turn, so a replayed request opens the panel.
- `087b115` Milestone C: one finish path for the Claude sidecar and plugin processes, capped plugin
  output, a watcher that says failures and does not follow symlinks, MCP tokens forgotten on retire,
  bounded plugin errors and Claude history, and a folder switch that builds before it closes.
  Tests: `agent/process.test.ts`, `plugins/process.test.ts`, `workspace/files.test.ts`,
  `mcp.test.ts`.
- `c26467c` Milestone D: one deadline for the jobs pump, capped host time, unhandled rejections
  reported, a circular result as an error, the runtime switching off on a jobs overrun, and the
  long budget for sessions. Tests: `plugins/engine.test.ts`.
- `d7f1409` Milestone E: one registry for the API's namespace groups and their answers; the
  runtime walks it and `api.test.ts` checks every case is routed.
- `b175772` Milestone E: `TrustStore` and `LimitsStore` leave `Store`; callers unchanged.
- `e4ca267` Milestone E: the startup pipeline moves to `startup.ts`, the core commands to one
  function, and limits become best effort. Shell, fake and fake-acp selftests pass.
- `f18c6ee` Milestone E: the core commands live in `commands.ts`; `Widecode.start` registers the
  ones every composed app needs and startup registers the store ones.
- `7511a8f` Milestone E: `PluginTable` owns definitions, running plugins, loaded sources and the
  generation counters.
- `d0ccaca` Milestone E: `ProcessTable` and `ViewTable` own plugin processes and drawn views.
- `a80e244` Milestone E: `HostRouter` owns `__host` calls and namespace dispatch.
- `7511a8f`, `d0ccaca`, `a80e244` Milestone E: `PluginTable`, `ProcessTable`, `ViewTable` and
  `HostRouter` split out of `JsRuntime`. The tab-column choice is closed by the existing type and
  API default.
- `6ace744` Milestone F: settings notices reset and invalid values are recorded; `Keyed` restores a
  replaced item; activation is guarded and a second `start` stops the first; duplicate screen ids
  replace. Tests: kernel and screen.
- `d641afc` Milestone F/G: `StatusInfo` types the plugin status input, `Kernel.remove` stops
  dependents, `Hook` moves to `lib`, stale comments and the em dash are fixed. Tests: kernel,
  screen, workspace and the app suite.
- `52c304c` Milestone G/H: shared JSON helpers and prelude `util`, `SessionMeta.of`/`toRow`,
  shared highlight string reader, reused function ids, and bounded workspace, history, ACP and
  status reads.
- `da50ec6` Milestone H: the first workspace listing is reused, the Git commit cache is capped, and
  markdown/plugins tests grow.
- `f154707` Milestone B: the conversation model keeps the newest 1000 turns and caps its lookup
  maps. `loadEarlier` still relies on the adapter resetting the model.
- `loadEarlier` resets the model in `Conversation`; the JS agent only calls its plugin.
- `3e244c7` Milestone B: `loadEarlier` resets the model in `Conversation`.
- Folder switches attach the old agent but start it only after the new folder's plugins load.
- A log path that cannot be opened is covered directly; a later path works.
- `f91d5a2` Milestone G: `noUnusedLocals` and `noUnusedParameters` are on for every member.
- `f91d5a2` Milestone G: unused checks are on. `scripts/lint.sh` and `scripts/ci.sh` add the prose
  and type checks and the full local gate.
- Agent process tests cover stop; history caps both files and parsed lines.
- `git status --branch` replaces the separate branch read.
- `chat/test/source.test.ts` covers the queued messages through `ChatSource`.
- The builtin plugin builder fills the languages list from `packages/highlight/languages.ts`.
- The quit path is `flushBeforeExit`, tested for order; the records' write itself is covered by the
  session-record tests.
- `plugins/test/node-budget.test.ts` documents the node stand-in's four-budget allowance.
- `util.wrap` escaped its `\s` for the generated prelude; without it every `s` became a space.
- `runtime/slots.ts` is the one slot order; runtime constants derive from it and `api.test.ts`
  compares the prelude's functions to it.
- The prelude's api binds each call to its registration; the router enforces the token and the
  owner-first registration calls.
- The title writer is `@widecode/agent/titles.ts`; model naming is `@widecode/agent/model-name.ts`. The
  status JSON stays Claude-shaped for the plugin contract.
- `StatusInfo` moved to `@widecode/agent/status-info.ts`; conversation re-exports it.
- `e55cb5d`, `50cc3e5` Milestone E: one slot table and registration-bound calls.
- `f3b14da`, `0d09b70` Milestone F: titles, model naming and `StatusInfo` in `@widecode/agent`.
- A child process covers the bad log path; `util.throttle` completes the prelude helpers.
- The rejection path has a native C driver; the node stand-in stays simple.
- `3e904d4`, `517aa43`, `509ed84` Milestone J: the harness as a daemon speaking ACP, the Anthropic
  client, the tools, the line diff, an entry kept static.
- `657ab06`, `ee55287` Milestone J: sessions as JSONL files with replay, fork, titles; compaction.
- `5c70011`, `a547f9f` Milestone J: skills, AGENTS.md and CLAUDE.md, widecode's MCP tools; WebFetch
  and WebSearch through a headless browser.
- `57cd6fa` Milestone J: the `harness` selftest and the README's section; two tests' expectations
  and teardown, one wait raised.
- `3d53538` The OpenAI-compatible client and OpenCode Zen; the Grep and Glob schemas made valid JSON.
- `1208ed2` The benchmark: eight tasks, a runner over ACP, the first live run.
- `53fe3cd`, `f9338f7`, `b001d9d` A deny list from `permissions.deny`, subagents, images.
- `7f7e773` The busy test reads its tool line without its clocks' seconds.
