# widecode on @lightstart/app

widecode becomes an app on `@lightstart/app`. Its folders are its app, and light writes the wiring. The app layer grows wherever widecode needs it. This file is the plan; it goes once the work is done.

## Where widecode is

- `main.ts` and `startup.ts` wire the app by hand, in about 400 lines. They handle the flags, the log, three run modes, the store, the config, the workspace, the conversation, the plugins, onboarding and resume.
- `Widecode` (`compose.ts`) and `Host` (`controllers/host.ts`) hold everything:
  - `Host` passes 14 named hooks through getters and a string switch.
  - Views take `Host` in their constructors, and `Widecode` builds the widgets before handing them to the plugin runtime.
- Opening a folder (`/open`) rebuilds by hand the workspace, conversation, folder controller, harness, session records and prompt history, while keeping everything else. Three layers each carry part of that logic.
- State lives in signals, hooks, plain arrays and kernel settings all at once:
  - the keymap, the columns and the agent each live in config, in state, in a controller and in a UI object;
  - there are five settings files with four merge policies.
- Persistence is split across:
  - two light models, opened by hand with `openJsonl` for each folder;
  - hand-written JSON files: config, state, trust, limits and keys;
  - a hand-written `history.jsonl`;
  - the agents' own transcripts.
- Every feature is a JavaScript plugin in one shared QuickJS context, the built-ins included. Chat, code and tools are plugins the app cannot run without, but they can still be switched off or replaced.
- `src/agent/claude.ts` and `src/agent/envelope.ts` are dead code; only `agent/mcp.ts` is imported.
- Tests build the app by hand (`openWorkspace` + `Conversation` + `composeWidecode` + `w.start`).

## Where it goes

```
src/
  app.ts                 defineApp({ name: "widecode", host: "tui", args, storage, root })
  modes/
    harness.ts           widecode --harness: the ACP agent, headless
    peers-daemon.ts      widecode --peers-daemon: the LAN git bridge
  models/                rows the app keeps; a model names its store
    sessions.ts  skills.ts  history.ts             (project store: <dir>/.widecode)
    trust.ts  limits.ts                            (user store: ~/.widecode)
  controllers/           named singletons; one imports another
    settings.ts          config.json, user then project, one merge policy; state.json; keys.json
    folder.ts            the workspace: files, status, compare base, watch
    session.ts           the conversation, the chosen agent, trust, records, titles
    screen.ts            columns, tabs, band, menus, focus, message
    keymap.ts            the user's layer and the plugin layers
    plugins.ts           the kernel and the JS runtime; the api the plugins call
    log.ts               the run's log, crash trail, F12
  views/
    app-root.ts          the shell: menu bar, columns, band; imports the controllers
    chat-pane.ts  code-pane.ts  tools-panel.ts  request-panel.ts  tab-column.ts ...
  conversation/ code/ chat/ ...   plain domain code, unchanged in shape
```

- **No `Host`, no `Widecode`, no `startup.ts`.** A view imports the controllers it draws; a controller imports the controllers and models it uses. What `Host` forwarded is read straight from its owner.
- **Hooks become signals.** Almost every hook today means "read the state again". The state becomes a signal on its controller, and `api.on("folderChanged")` and the rest are effects on those signals. The hook names have one list, and the prelude, `widecode.d.ts` and `PLUGINS.md` are all checked against it.
- **Opening a folder restarts the app.** `/open <dir>` asks the host to restart with `--dir <dir>`. The host stops the controllers and closes the stores, then opens and starts them again; the terminal stays. Everything scoped to a folder is opened once, at start, and the swap logic goes away.
- **Run modes are entries of their own.** `--harness` and `--peers-daemon` are `src/modes/<name>.ts`, dispatched before the terminal host starts. They share nothing with the interface but their imports.
- **Chat, code and tools are core views and controllers.** They stop being plugins. Plugins extend them through the api, as they extend the rest.
- **The core is the app layer's; the extension seam is widecode's.** Every plugin stays JavaScript in QuickJS, built-ins included. A plugin loads, reloads and unloads apart from the build, and runs inside the sandbox's budget and api. A compiled plugin would be part of the binary, or a native library loaded with every right the process has.
- **Tests open the app.** A test helper opens the manifest over a memory store, a temporary folder and `TestTerminal`, with any arguments, and returns the controllers and the screen.

## What the app layer gains

One light issue and one pull request, "the app layer runs a full terminal app":

| Need | What `@lightstart/app` gets |
|---|---|
| The app's own flags | `defineApp({ args })`, the declared options. The host parses them, and `app.args` holds them, typed, written once before the controllers start. This is the only thing the app object holds. |
| Run modes | `src/modes/<name>.ts`, each a default `main(argv): Promise<number>`. The generated `.light/main.ts` imports them statically and dispatches `--<name>` before the host. |
| More than one store, with folders taken from the args | `storage` names its stores, e.g. `{ project: { kind: "jsonl", dir: (args) => ... }, user: {...} }`, and a model says which store it lives in (the default one if it says nothing). |
| Restart | `restart(args)` on the handle, and as an import for a controller. It stops the controllers and stores, then starts them again with new args, keeping the terminal. |
| Quitting in order | `quit(code)`: stop the renderer, dispose the controllers in reverse, flush and close the stores, then exit. A controller's `disconnected()` is where its own flushing goes. |
| The terminal host in two steps | `prepare(manifest, options)` opens the stores and starts the controllers; `mount(root, { term, classes })` runs the view. `start` does both. |
| Tests of a terminal app | `openApp(manifest, { args, storage: "memory", terminal })` with `TestTerminal`, which mounts the root view. |

Left out of the app layer on purpose:
- an event bus: signals do this;
- a plugin system: the kernel stays widecode's;
- dynamic views: the screen controller is widecode's own registry of contributions.

## The rounds

Each round leaves widecode building, its 127 tests passing (except the `pi` one, which needs `pi` on PATH), and the binary installed and run by hand.

1. **light: the app layer above.** Issue, branch, pull request, gates, merge.
2. **widecode on the app layer:**
   - `src/app.ts` with the flags, and `native.entry` set to `.light/main.ts`;
   - the run modes in `src/modes/`;
   - the log and the crash monitor in a `log` controller;
   - `startup.ts` and `main.ts` removed;
   - the test helper in place, with tests moved onto it as they're touched.
3. **The controllers:**
   - `Host` and `Widecode` dissolved into `settings`, `folder`, `session`, `screen`, `keymap` and `plugins`;
   - views importing their controllers;
   - hooks replaced by signals;
   - `commands.ts` split, so each command lives with the controller it acts on.
4. **Persistence:**
   - the two stores;
   - `sessions`, `skills` and `history` in the project store, and `trust` and `limits` in the user store, with the old files imported once;
   - one settings merge for plugins, columns, permissions, keymap, agent and log.
5. **Opening a folder restarts the app**, and the swap code goes.
6. **The extension seam:**
   - chat, code and tools become core;
   - the built-ins are still plugins in `plugins/<id>/index.ts`, with their list generated;
   - one list of hook and namespace names checked against the prelude and the docs.
7. **The domain:**
   - a typed event union instead of the `unknown[]` switch;
   - `src/agent/claude.ts` and `envelope.ts` removed;
   - the Claude and ACP adapters split into transport, records and event mapping.

## Decided

1. **Plugins stay JavaScript**, the built-ins included.
2. **Opening a folder restarts the app.**
3. **Packages.** Splitting out `conversation`, `code` and the harness as packages inside widecode can come later. It's not part of these rounds.
