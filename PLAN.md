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
- [ ] **Later.** TLS pinned by peer id; an in-process mDNS responder over dgram; a push from the tab; the daemon as a login item.
- [ ] **To watch: a daemon's `fetch` to a peer that stopped answering.** On the Mac, one daemon kept answering "did not answer" for a peer whose daemon had been restarted, while curl and a fresh process reached it; a restart fixed it. The reasons are logged now (`ping …`, `repos of …` lines); if it comes back, suspect the native runtime reusing a connection the other side closed, and retry once on a closed connection. (`packages/peers/daemon.ts`)

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
