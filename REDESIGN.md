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
2. **widecode on the app layer** (done, `a2e525d`):
   - `src/app.ts` with the flags, and `native.entry` set to `.light/main.ts`;
   - the run modes in `src/modes/`;
   - one transitional controller, `src/controllers/widecode.ts`, doing what `main.ts` and `startup.ts` did, and the root view `src/views/app-root.ts` around the shell;
   - `startup.ts` and `main.ts` removed, and `Host` and the classes it builds moved to `src/host/` unchanged.

   On the way, light got:
   - the root view's `mounted(renderer)` hook (#62);
   - arguments that a native app can read (#64): `App` is a class, read with `app.args.string(name)` and `app.args.flag(name)`, because scriptc copies a value it converts;
   - controllers that start after the controllers they import (#66).
3. **The controllers**, in steps that each keep the tests green:
   1. **One test helper.** `openWidecode(options)` and `closeWidecode(w)` in `test/support/app.ts` are the only place a test builds the app. A test's tweaks go in `before(w)`. The tests are moved onto it mechanically, and the queue test is the example.
   2. **Through the app layer.** The helper opens widecode through `@lightstart/app/test` and its controllers, one app at a time. Tests that hold two apps at once become sequential, and the process-wide pieces (signal handlers, the crash monitor, the log) are installed once.
   Steps 1 and 2 are done (`bb7fc08`, `af87e07`): every test but `js.test.ts` opens widecode through the app layer, one app at a time.
   3. **Controllers.** Decided: (a), with one rule. A controller lasts, but its per-start state is one object it makes fresh in `connected()`, so a restart can't leak state.

      Done:
      - `run` (`2c64362`), the start's `Run`, and the restart over another folder;
      - `log`, the log, the process handlers and the crash report, once a process;
      - `settings`, the store and `config.json`: read with `readConfig`, and a first run's seeded with `seedConfig` once the plugins are known;
      - `kernel`, `screen` and `keymap` (`12411b2`);
      - `folder` and `session` (four commits, the last `94191ee`);
      - `host`, the `Host` facade, made from the controllers above.

      The start order follows the imports: run, folder, kernel, keymap, screen, session, host, log, settings, widecode. The `widecode` controller only composes the shell, the widgets and the plugin runtime over `host`, starts the plugins, and finishes the start once mounted.

      Left:
      - views importing the controllers instead of taking a `Host`;
      - hooks becoming signals;
      - commands moving to the code they act on;
      - `Widecode` (the plugin runtime, the widgets, the harness) becoming a `plugins` controller.

      What's in the way:
      - Loading the config needs the plugins' defaults, which exist only once the app is composed (`store.loadConfig(w.defaults())`). The defaults only seed a new `config.json`, so `Store.loadConfig` has to separate reading from seeding before a `settings` controller can start ahead of the composition.
      - The log opened in the store waits on that config.

      The decision, the user's:
      - **(a) Singletons that last.** Each controller keeps its instance across restarts and resets its state when it starts again. Views and the plugin api's answers import them, and `Host` and `Widecode` go. This is what the app layer means, and it's the most work: `src/api/*`, the views and the widgets all take a `Host` today.
      - **(b) Per-start objects.** `Host` and `Widecode` stay as what one start builds, reached through the `widecode` controller (`widecode.w`), and the work is narrower: split `Widecode` (the runtime, the widgets, the harness), thin `Host`'s forwarding, and move each command to the code it acts on.

      The items below are (a)'s:
      - The `widecode` controller splits into `log`, `settings`, `folder`, `session`, `screen`, `keymap` and `plugins`, each reset when it starts again, so a restart is a clean start.
      - Views import the controllers, and `Host` thins down to the facade the plugin api answers through.
      - Hooks become signals.
      - `commands.ts` is split, so each command lives with the controller it acts on.
4. **Persistence:**
   - the two stores;
   - `sessions`, `skills` and `history` in the project store, and `trust` and `limits` in the user store, with the old files imported once;
   - one settings merge for plugins, columns, permissions, keymap, agent and log.
5. **Opening a folder restarts the app** (done, before round 3's last step: it needed only the test helper on the app layer).
   - `/open` keeps its checks: not a folder, already opening, the agent still working.
   - Then the `widecode` controller's `reopen` carries the agent chosen, its CLI and arguments, the model and the effort over, and calls `app.restart({ dir })`. The restart resumes no session, opens no file and starts no selftest.
   - `SessionController.open`, `Widecode.folderOpened`, the widgets' and plugins' `folderOpened` listeners and the hook itself are gone.
   - A test gets the app after an `/open` from `currentWidecode()`, and the `open` selftest checks it in the binary.
   - On the way: the Tools tab redraws when the conversation changes, since it used to keep the old calls after a reset.
6. **The extension seam:**
   - chat, code and tools become core;
   - the built-ins are still plugins in `plugins/<id>/index.ts`, with their list generated;
   - one list of hook and namespace names checked against the prelude and the docs.
7. **The domain:**
   - a typed event union instead of the `unknown[]` switch;
   - `src/agent/claude.ts` and `envelope.ts` removed;
   - the Claude and ACP adapters split into transport, records and event mapping.

8. **Plugins are normal files** (decided after round 3; done: light #68, #70 and #72; widecode `80fef98`, `c80a645`, `df1b920`, and the adapters' split after them). Every built-in, the agent adapters (`claude`, `acp`, `pi`) among them, is a plugin folder on disk. The binary embeds none, and built-ins and user plugins load the same way.
   - **light, `@lightstart/plugins`:**
     - a plugin is ES modules: `JsEngine.addModule(file, code)` registers a plugin's files, and `evalModule(code, file)` runs its entry;
     - the engine resolves a relative import only among the registered files, so a plugin still reaches nothing else;
     - natively, this is quickjs-ng's module loader; under node it's `vm.SourceTextModule` in the stand-in.
   - **widecode's runtime** loads a folder (`<id>/index.js` with its other files) or a single file, as today.
   - **Installing:** `light install` writes the built-ins into `~/.widecode/plugins/<id>/` with their types stripped and their file names kept.
     - It records each folder's hash, and replaces only a folder it wrote itself whose files are unchanged.
     - A folder the user edited is left alone and named in the output.
     - Plugins with the same id still resolve as today (the user's after the built-ins'), but a built-in edited in place is simply the user's now.
   - **Goes away:** `src/runtime/builtin.ts` and its strings. The harness's agent parts and the tests load the same files: the repository's `plugins/`, stripped into a generated folder for a test run.
   - **After that:** `claude` (1.9k lines) and `acp` (2.7k lines) split into files: transport, records, event mapping.

## Decided

1. **Plugins stay JavaScript**, the built-ins included, and become normal installed files (round 8).
2. **Opening a folder restarts the app.**
3. **Packages.** Splitting out `conversation`, `code` and the harness as packages inside widecode can come later. It's not part of these rounds.
