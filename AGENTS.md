# widecode: native apps on light

This repository holds widecode, the Claude Code frontend for wide terminals, and its desktop chat:
light-native apps, TypeScript on light's native core (signals, `html` templates, the view core, the
terminal host `native/tui`, the desktop shell), compiled by scriptc into one static binary with no
JavaScript engine (no Node, Bun or Deno at runtime). The one engine allowed is an embedded QuickJS
for plugins a user changes while the app runs (`@light/plugins`); an app's core stays compiled. It
is a pnpm workspace that links light: `light` is the checkout beside this one (`../light`, consumed
as `@lightstart/light`), and light's packages for native apps (`@light/<name>`, light's
`packages/README.md`) are members here too; `packages/*` are what these apps share
(`@widecode/<dirname>`), `apps/*` the apps. What an app needs from the framework (a widget, a host
capability, a fix in the renderer) goes into light, what any native app could use goes into light's
packages, and what only these apps share goes into a package here; nothing is imported by relative
path across members. The compiler is the scriptc fork at `../scriptc` (its `FORK.md` lists the
patches light needs).

| Path | What it is |
|---|---|
| `light/packages/native/*`, `light/packages/tui/*` | light's packages: `@light/cli` (`light-native`, the tooling: build, run, selftest, test, coverage, typecheck, check, install, desktop), `lib`, `highlight`, `plugins`, `workspace`, `test`, `kernel`, `ui`, `markdown` (light's `packages/README.md`) |
| `packages/agent` | the `claude -p` sidecar (spawn, envelopes) and the MCP server an app serves its own tools with |
| `packages/conversation` | the conversation with an agent, agent-neutral: the model, the events, the agent role, requests, status, the lines a view draws, the session records an app keeps |
| `packages/screen` | the screen plugins contribute to: columns, tabs, band strips, segments, `ScreenController`, the column element |
| `packages/code` | the code column: a file with its changes in place, the view, a subagent's steps, a call's page, the `CodeTarget` role |
| `packages/chat` | the chat views: the transcript with the composer, the request panel, the completion strip, the Tools tab, the `ChatTarget` and `ToolsTarget` roles, on a `ChatHost` the app provides |
| `packages/harness` | widecode's own coding agent, the harness: a daemon of the binary (`widecode --harness`) speaking ACP over stdio to the ACP plugin, talking to model APIs directly, running its own tools, keeping its own sessions (`PLAN.md`, milestone J) |
| `apps/widecode` | widecode, the Claude Code frontend for wide terminals (chat, files, code), installed as `widecode`: a native core and JS plugins; a project's `.widecode/` is its harness, which the agent edits |
| `apps/desktop` | the chat as a desktop app: a scriptc backend on light's desktop host, a light page in the system web view |
| `probes/` | one-file compiler probes from widecode's start and the rules they produced (`probes/README.md`); `p0-workspace/` is the probe the workspace's import route rests on; light's `native/probes/` continues the work |

## Git and commits

- **NEVER add `Co-Authored-By:` or `Claude-Session:` trailers to a commit message.**
- **This repo is not synced with a remote. Never push, pull, fetch, or mention the remote's state; local commits and merges are the whole workflow.**
- A commit message is `<area>: <what changed>` (the area is the app or package: `widecode`,
  `desktop`, `packages`, `probes`, `docs`), then a body of plain paragraphs saying what
  changed and why. The prose rules below apply.
- Checks come in three sizes, so a change is tried in seconds and the whole native run happens once
  a series ends:
  - While working: the tests the change touches, under node
    (`light-native test <member> --node-only -- <name>.test.ts`, seconds).
  - Commit green (a few minutes): `light-native check --all`, `light-native typecheck --all`,
    `light-native test --node-only` (every member's tests under node, about two minutes), the
    tests the change touches natively as well (`light-native test <member> -- <name>.test.ts`:
    under node and natively, outputs equal) and `light-native coverage --apps` (the app entries
    compiling statically). A change to an app also runs the selftests that drive what it changed:
    `light-native selftest widecode shell` for the core, `fake` for Claude Code's plugin,
    `fake-acp` for the acp plugin, `harness` for the harness.
  - A series of commits ends with `pnpm verify` (every member's tests natively too), run in the
    background while the next work goes on. With scriptc's cache warm it takes about six minutes
    after a change to plugins, docs or tests (a test run reads the plugins' code when it starts,
    so none of that recompiles it); a change to the compiled core recompiles the tests that
    include it, every app test for `src/` (about twenty minutes). What it finds is fixed in a
    commit of its own.

## Prose style (docs, READMEs, commit messages, UI copy)

- No em dashes. Use commas, periods, colons, or parentheses.
- No "it's not X, it's Y" or "not just X but Y" contrast framings.
- No filler adjectives (seamless, robust, comprehensive, powerful) and no "Note that / It's worth noting / Importantly" hedges.
- No rule-of-three padding. Plain declarative sentences. A section earns its length with information, not enthusiasm.
- No reassurance asides in UI copy. Say what a thing is and what it does.

## Members

- A member follows light's layout for one (light's `packages/README.md`, "A member"), which
  `light-native check --all` holds it to: a `package.json` (`"type": "module"`, `"private": true`),
  a `tsconfig.json` identical to `@light/cli`'s `templates/tsconfig.json` (scriptc reads the one
  nearest an app's entry for the whole program, so every member typechecks under the same options),
  a `README.md`, and `test/*.test.ts`. A package here is `@widecode/<dirname>` with
  `exports: { ".": "./index.ts", "./*": "./*" }`: every export target is a `.ts` file, which is
  what lets scriptc compile a bare import of a linked package as program source (a `.js` target
  would make it an npm package and fail the build, probe p0).
- A member declares in its package.json every member and `@lightstart/light` it imports, as
  `workspace:*`; `@light/test` and `@types/node` are devDependencies. Imports are by
  name (`@lightstart/light/native/tui`, `@lightstart/light/native/tui/lines.ts`, `@light/lib/json.ts`); a
  relative import never leaves the member.
- The dependency order: light's packages (lib, highlight; plugins, workspace; test; kernel, ui;
  markdown), then agent; conversation; harness; screen; code; chat; then the apps. A package never imports
  an app, nor a package after it in this order; light's packages never import one of these.
- An app's `native` block names its entry, its binary, its FFI manifest (`@light/plugins/native/ffi.json`
  for one with plugins), its prepare steps (shell lines run in its folder before a build, a test
  run, coverage or typecheck) and its selftest scenarios; a package with a native part names its
  build as a prepare step (`@light/plugins`), run for every member that depends on it.
- The third time a piece of an app is hand-written for another app, it moves to a package, to
  light's packages or into light; a generic terminal widget (a tab column, a bordered column, a
  markdown renderer) belongs in light's `native/tui/` once it needs nothing of the kernel.

## Making an app

- `apps/<name>/src/main.ts` is the entry, on light's `runApp({ app, term, focus, onKey })`. An app
  is a light app in the MVC shape: `src/controllers/` are `Controller` subclasses whose signal
  fields the views read in their render and which the views call for the change they want
  (widecode's `host.ts` is the facade its plugins and views are given, over the packages'
  `ScreenController`, `FolderController` and its own `SessionController`); `src/views/` are light
  `View`s with signals and `html` templates, composing the packages' views; `src/services/` is
  what the app keeps (its store, its harness folder); `src/compose.ts` builds the app; a theme
  module sets the palette's fields it wants otherwise (`@light/ui`'s `palette`).
- Long lists render through light's windowed `LineView` over a `LineSource` (light's
  `native/tui/README.md`), whose press and copy are events a parent handles; a view a template names by
  tag is registered with light's `define(tag, make)`: its props are `this.prop(name, initial)`, it
  emits with `$emit`, and the `<slot>`s of its template take the children the parent wrote inside
  the tag. The theme's utility classes style terminal elements once the entry calls
  `configureClasses(new TerminalClasses(theme, scheme))` (light's `theme/README.md`, Hosts).
- `light-native build <app>` builds the binary into the app's `dist/`, `light-native run <app>` runs it in the
  current folder, and `light-native selftest <app> <scenario>` runs a scripted end-to-end check in a
  pseudo-terminal on a temp repository, the app writing its outcome to the `--log` file; a pty
  driver (`apps/widecode/test/drive.py`) runs the binary as a user would, reading the screen back.
- Tests are `test/*.test.ts` in the member, plain scripts on `@light/test/assert.ts`, run from the
  member's folder (fixture paths relative to it), headless (the app mounted on a `TRoot` and
  painted to a `Screen`, `@light/test/headless.ts`). `light-native test` runs each under node and natively and
  fails when the outputs differ; `light-native coverage` compiles every test; a test's first line may be
  `// ffi: <manifest>` (it reaches native calls bound by that manifest; node preloads the
  manifest folder's stand-in) or `// node-only` (it walks the file system).

## widecode's plugins

widecode is a native core and JS plugins (`apps/widecode/PLUGINS.md`). The core is compiled: the
packages above, and in the app its controllers, views, the plugin runtime (`src/runtime/`: the
`JsRuntime` over `@light/plugins`' engine, the JS-drawn views, the agents plugins bring, the prelude)
and the API's answers (`src/api/`, a file per namespace). Every feature is a plugin running in
QuickJS: the built-in ones are `apps/widecode/plugins/<id>/index.ts`, type-checked against
`widecode.d.ts` and stripped into the binary by `scripts/builtin-plugins.mjs` (the app's prepare
step); the user's and a trusted project's are `.js` files that reload on save, each file alone,
the agent and the other plugins untouched.

- A feature goes in a plugin. What a key does is an action (`api.keys.action`), what a key is
  bound to a keymap (`api.keys.layer`, the user's `keys.json`); a keymap such as emacs or vi is a
  plugin of layers (`plugins/vi/index.ts`). What a plugin needs from the core is one call per need: the
  prelude (`src/runtime/prelude.ts`, the namespaces `@light/plugins` builds the prelude around), its
  answer in its namespace's `src/api/<file>.ts` (`src/runtime/runtime.ts` dispatches to them), its
  type in `widecode.d.ts`; `test/api.test.ts` checks the three agree. Heavy work (git, the tree,
  diffs, rendering the conversation) stays native; a plugin decides what to show and draws rows
  for the visible window.
- Values cross as JSON; what the core answers later is a promise the runtime settles. A call into a
  plugin has a time budget (250 ms, 2 s for an agent's history read; the core's own time not
  counted) and runs on whatever stack the core is on, an async function's fiber included
  (`@light/plugins`' `native/wcjs.c` measures it).
- A plugin reaches another only through a command, a role (the chat and code columns, the Tools
  tab), a segment or the core's state, never by its code.
- The run's log is on by default, a file per run under the store (`@light/lib/log.ts`, README's
  settings paragraph). Natively an error has no stack, so the entry has `trail` around it: a key
  (`shell.ts`), a plugin's call (`runtime.ts`), the agent's events (`api/agent.ts`) and a frame's
  phases (`main.ts`) enter and leave it, and the uncaught-exception monitor in `main.ts` logs the
  error with what was open, the latest entries, the session and the turn, and the screen. A new
  place work runs from (a timer's callback, a process's lines) enters the trail too. The `crash`
  selftest checks the entry.
- A project's `.widecode/` is its harness (`src/services/harness.ts`, PLUGINS.md "The harness"):
  `plugins/*.js`, `prompt.md` (appended to the agent's system prompt after a fixed paragraph that
  says the agent runs inside widecode and names the tools it has) and `config.json` (over the
  user's), in use once the folder is trusted (asked on the first launch there, or `/trust`; the agent
  stays out of an untrusted folder) and watched, each part applying on its own. What the agent
  may change about widecode goes in this folder, never in the compiled core. Tool permissions are
  Claude Code's rules (`permissions` in either config.json), handed to the CLI with `--settings` and
  enforced by it; a `can_use_tool` that is not a question or a plan is a permission the request
  panel puts to the user. The harness plugin (`plugins/harness/index.ts`) is how the agent probes: the
  tools `screen`, `state`, `log`, `api`, `check`, `reload` and `config` over `api.plugins`,
  `api.harness` and `api.state`; `scripts/builtin-plugins.mjs` embeds PLUGINS.md and
  `widecode.d.ts` into `src/runtime/docs.ts` (generated, ignored) for `api`, and writes the build's version and time into `src/runtime/build-info.ts` (generated, ignored), which `--version`, the log's first line and the status bar's first message say.
- A plugin's tests drive it through the app (`createWidecode`) and start with
  `// ffi: @light/plugins/native/ffi.json`, so `light-native test` runs them natively with QuickJS and under
  node with the package's `wcjs-node.mjs`. A plugin switched off has a test too.

## The compiler (scriptc static mode)

`light-native` compiles with `$SCRIPTC`, else the fork's `scriptc-dev` on PATH, else the scriptc
installed at the root (upstream lacks the fork's patches and fails on light). The wrapper keys scriptc's
cache (`SCRIPTC_CACHE_DIR`) by the fork's commit and build time, so unchanged programs and
coverage verdicts come back from it (the fork's `FORK.md` has the wrapper). It sets
`SCRIPTC_CACHE_MAX_MB=20480`: every test is an executable of its own, a full run's builds take
about 14 GB, and under scriptc's default 4 GB cap each run evicts what the next one asks for. A compiler bug found here gets a
probe in light's `native/probes/`, a one-file program that prints the same lines under node and
natively, and a row in its `README.md`; prefer fixing scriptc over working around it when the fix is in reach. The
rules the code follows today:

- No `any`. Dynamic data is `unknown`, read through interfaces whose fields are all `unknown`
  (`@widecode/conversation`'s `events.ts` `Ev`) or narrowed with `JSON.parse(s) as { ... }`.
- What needs identity is a class. An instance keeps its class through `unknown`, not through a
  parameter typed with its base class: prefer one flat class over a hierarchy that downcasts. What a
  package needs of an app is an abstract class with the methods it calls (`SessionStore`,
  `ConversationHolder`, `ChatHost`), which the app subclasses; a method rather than a field where
  the app may replace what it answers.
- Callbacks are nullable function fields (`onOpen`). A function-typed field never shares its name
  with a method anywhere in the program. A Map or Set holds class values, never functions (wrap a
  function in a class).
- `JSON.stringify` refuses class instances: build literals typed `unknown`. Never depend on the key
  order of its output (literals with the same keys share a layout natively, p39).
- A class field typed as an array of an interface is refused (use `unknown[]`); an
  `unknown`-typed field needs the fork. An empty `[]` returned where a typed array is expected
  needs a typed binding (`const none: Branch[] = []`).
- Parsed JSON stays short-lived (p37): keep records as text and parse one while applying it.
- `spawnSync` takes no `cwd` natively: `git -C <dir>`, or `sh -c "cd <dir> && ..."`.
- Erasable TypeScript only, so the same file runs under node for fast feedback.
- `light-native coverage` stays static (`--fail-on=slow-paths`, no site compiling dynamically).

## Agents

- Apps reach an agent only through the CLI the user installed: Claude Code's `claude` over
  `stream-json`, an ACP agent (`opencode acp`) over stdio. Never bundle an agent's binary or embed
  an SDK that wraps it (the Agent SDK is a wrapper around Claude Code's binary).
- The conversation is agent-neutral (`@widecode/conversation`) and every agent is a plugin of the app:
  Claude Code's is widecode's `plugins/claude/index.ts`, ACP agents' `plugins/acp/index.ts`, over `api.agents`,
  `api.process.spawn`, `api.fs` and `api.conversation.apply`.
- widecode's own tools for an agent (`plugins/ask/index.ts`: a question, a plan to approve, both in the
  request panel) are plugins over `api.tools`, served by `@widecode/agent`'s MCP server (127.0.0.1, a
  token per agent plugin, no library), named by the app. A tool names the agent plugins whose
  agents do not see it (`except`): the ask plugin's except Claude Code, which keeps AskUserQuestion
  and ExitPlanMode; every other tool reaches every agent, Claude Code through `--mcp-config` (a
  file the user alone reads), ACP agents that take MCP over HTTP in their session.
- Tests and selftests spawn agents with `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT`. Checks that
  talk to a real agent run only when asked (`NATIVE_LIVE=1`), on its cheapest model (Claude: haiku at
  low effort with `--no-session-persistence`); everything else replays recorded fixtures through
  `apps/widecode/test/fake-claude.mjs` or runs against `apps/widecode/test/fake-acp.mjs`.

## On the user's machine

- Screenshots capture the app's own window (`xwininfo -name`, `import -window`), never the screen.
- Never stop a process this session did not start. `pkill -f <pattern>` also matches the shell
  running it; find the pid and check `/proc/<pid>/comm` first.
- A look at an app on one of the user's real projects is read-only: nothing is sent to Claude
  there, and anything the app writes there is reported.
