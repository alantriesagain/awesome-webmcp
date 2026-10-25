# widecode's plugins

widecode is a native core and JavaScript plugins. The core is compiled by scriptc: the terminal and
the layout, the views (tabs, the status band, rows), the chat, code and tools widgets, the services
(files, git, the watcher, the Claude session, the store, titles, processes) and the tokenizers.
Every feature is a plugin running in an embedded QuickJS: the chat and code columns' wiring, the
Tools, Agents, Files, Sessions and Git tabs, the changes and status bars, the models, the languages,
and the agents: Claude Code, and the ones that speak ACP (opencode, the DeepSeek Harness). Plugins can be switched off in
`config.json`, replaced by a file of the same id, and edited while widecode runs.

```
apps/widecode/
  plugins/        the built-in plugins, one <id>.ts each (TypeScript checked against widecode.d.ts)
  widecode.d.ts   the plugin API, for type checking and editors
  scripts/        builtin-plugins.mjs: the plugins and the docs stripped into the binary (a prepare step)
  src/
    main.ts       the entry, on light's runApp
    compose.ts    the app composed: the host, the widgets, the runtime, the built-in plugins
    controllers/  Host (the facade plugins and views are given: the kernel, the screen, the folder,
                  the session, the hooks, the roles) and SessionController; HostChat, the host as
                  the chat views see it
    views/        the shell (the columns, the band, the keys), the tab columns, the role players
                  (the chat, code and tools widgets), the onboarding
    runtime/      the plugin runtime: JsRuntime over @light/plugins' engine, the prelude (widecode's
                  namespaces around the builder), the JS-drawn views, the agents plugins bring
    api/          the core's answers to the plugins' calls, a file per namespace
    services/     the store (~/.widecode), the harness folder (.widecode/), the session titles
    theme.ts      widecode's look: the palette's fields under the core's names, the plugins' theme
packages/         what the core builds on: @light/kernel, @light/plugins (the QuickJS shim, its build
                  and FFI manifest, its node stand-in for tests), @widecode/conversation, @widecode/screen,
                  @widecode/chat, @widecode/code, @light/workspace, @light/highlight, @light/ui, @widecode/agent, @light/lib
```

## Where plugins come from

1. The built-in plugins, `apps/widecode/plugins/*.ts`. The build strips their types
   (`scripts/builtin-plugins.mjs`, node's `stripTypeScriptTypes`) into the binary.
2. The user's, `~/.widecode/plugins/*.js` (or `$WIDECODE_HOME/plugins`).
3. The project's, `<folder>/.widecode/plugins/*.js`, once the folder is trusted (the question on
   the first launch there, or `/trust`). A cloned repository could carry one, so until then widecode
   only says what the files register. The folder is the project's harness ("The harness", below).

They load in that order, each file in name order. A plugin with the id of an earlier one replaces
it, so a file named for a built-in plugin's id (`status`, `git`) overrides it. Saving a file in a
plugin folder reloads that file alone: its new source is evaluated first (a file that fails to
evaluate keeps its previous plugins running and says why), then the plugins it defined are stopped,
what they registered dropped and their functions freed, and the new ones started; the other plugins,
the agent and its conversation go on, so a plugin the agent writes takes effect while its turn runs.
A file that defined several plugins replaces them all; a file removed takes its plugins away, and a
built-in a removed file had replaced comes back. `/reload` is the full reload: it stops every
plugin, the agent included, evaluates the sources again in a fresh context and starts them, then
fires the hooks so they catch up; the conversation keeps its session, which the agent resumes on
the next message.

For editor checking, start a plugin with

```js
/// <reference path="/path/to/writting-harness/apps/widecode/widecode.d.ts" />
// @ts-check
```

## The life of a plugin

```js
widecode.plugin({
  id: "notes",
  requires: ["code"],
  defaults: () => ({ greeting: "hello" }),
  activate(api) { /* register, listen */ },
  deactivate() { /* optional */ },
});
```

The kernel reads config.json's `"plugins"` object (`false` switches a plugin off) and the state
file, then activates each plugin that is on after the plugins it `requires`. One whose requirement
is off or missing is left out and reported. `defaults()` answers the plugin's section for a new
config.json (`true` when it has no settings). In `activate(api)` a plugin registers what it
contributes and listens to hooks; `api` is its own, so what it registers is its and goes when it
stops.

## The API

`widecode.d.ts` types all of it; this is the map.

| Part | What it gives |
|---|---|
| `commands` | `add({ name, usage, help, run(arg), complete(arg) })`, `run("/files changed")` (any plugin's command); `complete` names the values the argument takes given what is typed, listed above the composer (↑↓ choose, Enter runs the command with one, Tab fills it in) |
| `keys` | `action({ id, scope, help, key, run(key, count) })` an action a keymap can bind, with its default key(s); `add(spec, scope, hint, run(key))` a key bound to a function (an action named `<plugin>:<spec>`); `layer(id, table)` a keymap over the actions, `on()` and `off()`; `run(id, count)` an action by name (see Keys below) |
| `composer` | the chat's composer, for a keymap plugin that edits it: `get()` (its lines, caret, whether it is empty, whether the suggestion strip shows or the request panel is open), `set(lines, row, col)`, `insert(text)`, `setLabel(text)` (its border title, a mode indicator) |
| `on(hook, run)` | `conversationChanged`, `sessionsChanged` (a session record of the folder changed: a title, a cost), `filesLoaded`, `statusLoaded`, `folderChanged`, `folderOpened`, `baseChanged`, `fileShown`, `messageSending`, `keymapChanged`, `messageChanged` (the status message set by `tell`, or cleared), `toolsChanged` (a tool added or dropped, after the runtime settled), `harnessChanged` (the project's `prompt.md` saved, or the folder trusted); a listener gets nothing and reads what changed |
| `tell`, `note` | a message in the status bar for a while; a line in the log |
| `ui` | `panel({...})` a tab of a tab column (`column`: `side`, the files column, or `tools`, beside the chat; with a `badge()` for its link on the band), `band({...})` a strip of the status band under a column (`under`: `chat`, `tools`, `side`, `code`), `segment({...})` a status segment; `drawSegment` and `pressSegment` reach any plugin's segment |
| `widgets` | `chat({...})` and `code({...})` mount the core's widgets as columns, `tools({...})` the Tools tab in the tools column; the plugin that mounts one plays its role for the others |
| `chat`, `code` | the roles: `submit`, `showChat`, `loadEarlier`; `open`, `openCommit`, `openAgent` (a subagent's steps), `openCall` (a tool call whole), `view({ id, count, rows, press })` (a view of the plugin's own rows, `show(title)` putting it in place of the file, Esc back), `path`, `inCommit`, `inAgent`, `position`, `scroll`, `moveHunk`, `setWrap` |
| `state` | `folder()` (branch, marks, counts), `changes()` (newest first), `paths()`, `base()`, `active()`, `panels()`, `columns()`, `commands()`, `batch()` (the watcher's latest), `info()` (Claude Code's status line input), `note()`, `screen(columns)` (the screen as drawn, the named columns cropped to their cells), `log(n)` (the last lines of the log) |
| `actions` | `focus`, `showPanel`, `quit`, `openFolder`, `setBase`, `relative`; `loadFiles`, `loadStatus` (promises) |
| `agent` | the conversation with the agent: `info` (which agent), `send`, `interrupt`, `reset`, `resume`, the model, effort and mode, its id and title, its first exchange, the agent's edits, its subagents (`agents()`), the tools it has (`tools()`) |
| `state.keymap`, `keys.keymap` | the keymap in use (`"default"`, or a plugin's id); a keymap a plugin brings, for /keymap and config.json's `"keymap"` (hook `keymapChanged`) |
| `agents`, `conversation` | `register({ id, name, start, send, … })` an agent the conversation can talk to; `apply(events)` its messages, as the conversation's changes (see Agents below); `ask(request)` a question or plan for the user from one of widecode's tools, a promise of the reply |
| `tools` | `add({ name, description, input, call(args) })` one of widecode's own tools, which agents call over MCP; `server()` where widecode's MCP server listens, for an agent's plugin to offer it (see widecode's own tools below) |
| `plugins` | the plugins as the runtime holds them, for the harness plugin: `list()` (every registration with its file and state, running, failed, off, replaced or stopped, and the last errors), `reload(file)` (a plugin folder's file evaluated again once the call returns; "" for every plugin), `check(code, file)` (a source evaluated in a context of its own, nothing registered: its plugins, errors and warnings), `api()` (PLUGINS.md and widecode.d.ts as the binary carries them) |
| `harness` | `info()`: the project's `.widecode/` as it stands (present, trusted, its plugin files, its prompt, its config beside the user's and the result of one over the other, the tools the agent sees) |
| `sessions`, `store`, `titles` | the folder's sessions with the agent (their titles, first and last prompts, folder, model, time and size) and `rev()`, which moves when the agent's list changed; widecode's record of a session; short titles Claude writes for Claude Code's sessions |
| `git` | reads, as promises: `branches`, `log`, `commitFiles`, `defaultBranch`, `mergeBase`, `head`, `commitAt`, `aheadBehind(a, b)`, `rootCommit`, `remoteBranches(remote)` |
| `peers` | the LAN git bridge: `ensure(start)` (this machine's daemon, started by the real app when the bridge is in use or `start` asks), `request(method, path, body)` on its control API, `share()` this folder's repository, `clone(peerId, key, name, path?)` a peer's offer cloned beside this folder and shared, `remotes()` (the peers with a remote here; the daemon writes one, named after the peer, into every shared checkout it fetches) |
| `files` | `tree(expanded, changedOnly)`: the visible rows of the folder's tree |
| `languages` | `add({ id, extensions, fences, tokenizer })` with one of the core's tokenizers |
| `process` | `run(command, input, timeoutMs)`: a promise of `{ code, out, err, timedOut }`; `spawn(command, { cwd }, { lines, exit, error })`: a process that keeps running, its output in batches of lines, `write(line)`, `stop(graceMs)`, `kill()` |
| `fs` | files read, never written, answered at once: `home`, `env`, `executable` (the running widecode's path), `list(dir)`, `stat`, `read(path, start, length)`, `text(path)`, `window(path, before, maxBytes, skip)` (the lines before a byte offset, as a transcript is read backwards) |
| `clipboard` | `copy(text)`: OSC 52, or xclip/xsel/wl-copy where the terminal does not take it (config.json's `"clipboard"`) |
| `every`, `after` | a timer while the plugin runs; once, later |
| `settings` | `section()` (its part of config.json), `state()` and `setState(value)` (kept in `~/.widecode/state.json`) |
| `widecode.util` | `width`, `clip`, `clipRuns`, `pad`, `runsWidth` in terminal cells as the screen counts them; `age`, `elapsed`, `tokens` |
| `widecode.theme` | the colors the core draws with, by what they mean (`dim`, `ok`, `bad`, `warn`, `think`, `link`, `code`, `prompt`, `selected`, `shown`, `fresh`, `band`, `marks` by git mark), and `spinner(now)`: a plugin drawn with them changes with the core's look (src/theme.ts) |

A row the core draws is a string or `{ bg, runs: [{ text, fg, bg, bold, dim, italic, underline }] }`;
colors are `#rrggbb`, `0` to `255` or a name. A tab draws only the rows its window shows
(`rows(from, count, width)`), so a long list costs what is on screen; `width` leaves out the
cell at the tab's right edge, where its scrollbar goes.

The band under the columns is in parts, each as wide as the column above it: the status table
under the chat, the tools column's tabs' links and the calls' status table beside them, the files
column's tabs' links (a plugin's tab joins its column's, with its badge), the changes under the code
column. A strip names the column it goes under. In a tab, as
in the chat and code columns, a drag selects and its release copies; a press without one is a
press.

## Keys

What a key does is an action: a name ("files.open", "app.focus.code", "chat.history.back"), a
scope, a help text and its default key(s). The core adds its own (the shell's F-keys and Esc, the
chat's history and suggestion keys, the Tools tab's) and a plugin adds its own with
`api.keys.action({ id, scope, help, key, run })`; `run(key, count)` answers true when it took the
key. `api.keys.add(spec, scope, hint, run)` is the same with a name made from the key
(`<plugin>:<spec>`); with a spec of `""` it is a hint alone.

Key specs are modifiers then the key: `f5`, `alt+down`, `shift+tab`, `ctrl+char:c`, `char:]`, or
`*` for any key. A scope is `""` (anywhere), a column (`chat`, `tools`, `side`, `code`), a tab
(`calls`, `agents`, `available`; `files`, `sessions`, `git`), or `input`, the composer, in effect
while the chat column is active and tried last. A key goes to the shown tab's actions, then the
active column's, then the global ones, then the composer's; in a scope, the key's own actions come
first (the one added last first), then the scope's `*` actions, until one returns true. A `*`
action sees `key.spec`, which carries the modifiers, so it can leave Ctrl+C alone. A key nobody
takes does nothing.

The composer's editing is the `input` scope's actions, each with the keys light's editor gives it:
`editor.left`, `right`, `wordLeft` (Alt+←, Alt+B), `wordRight` (Alt+→, Alt+F), `up`, `down`,
`lineStart` (Home, Ctrl+A), `lineEnd` (End, Ctrl+E), `backspace` (also Ctrl+H), `delete` (also
Ctrl+D), `killToStart` (Ctrl+U), `killToEnd` (Ctrl+K, to the clipboard too), `deleteWord` (Ctrl+W,
Alt+Backspace), `yank` (Ctrl+Y, the last kill), `newline` (Alt+Enter, Shift+Enter, Ctrl+J),
`submit` (Enter), `undo` (Ctrl+_, what Ctrl+/ sends) and `redo` (Alt+_), and `insert` on `*`
(a character or a paste; a key with a modifier that no action takes does nothing). Undo steps are
the keys that changed the text, a run of typing as one. An action's `run` gets a count (1 from a
key; a keymap plugin's `api.keys.run(id, count)` repeats a move or a delete).

A keymap binds keys to actions by name, per scope: `api.keys.layer("mine", { "": { f6:
"app.focus.code", f5: null }, code: { "char:k": ["test.two", "test.hello"] } })`. A layer's
entries come before the actions' default keys while it is on (from the start; `off()` and `on()`
switch it, so a mode is a layer); a later layer comes before an earlier one, and the user's
`~/.widecode/keys.json` before all. An entry names one action or several (the first that takes the
key wins), or `null` to bind the key to nothing. A layer with a `*` entry for a scope is a whole
keymap for it: it decides every key of the scope it does not name (a vi mode's normal mode is
`{ input: { "*": "vi.normal" } }`, the composer's own keys behind it). A later action of an id
replaces the earlier, so a plugin can replace the core's.

The hints in the status bar and `/help` are written from the actions: each action's keys as the
keymap binds them now (its first default key, the others being variants with modifiers, and the
keys layers added), then its help (`F5 model`); actions of a scope with the same help show as
one (`n/p changes`, `↑↓ Enter opens`); a help written key first, as `keys.add` hints were (`a add`),
or one with no key at all (`Enter sends`) shows as written; an action whose keys a keymap unbound
shows nothing. The status bar leaves the composer's editing out; `/help` lists it.

The user's `~/.widecode/keys.json` is the keymap's top layer, the same table (`{ "": { "f6":
"app.focus.code", "f5": null }, "code": { "char:n": null } }`), read at start and on `/reload`; a
malformed file is said and left out. A keymap a plugin brings (emacs, vi) registers with
`api.keys.keymap({ id, name })` and turns its layers on when `api.state.keymap()` names it, at
activate and on the `keymapChanged` hook: `"keymap": "vi"` in config.json chooses it at start,
`/keymap <name>` switches and keeps the choice in state.json, which comes first on the next start;
emacs is in use when neither says.

The vi keymap (`plugins/vi.ts`) shows how a mode is made: a layer with `{ input: { "*":
"vi.normal" } }` turned on in normal mode, whose action keeps the count, the operator and the
register in the plugin and edits the composer through `api.composer`; a layer on while the keymap
is in use, with Esc in the chat scope chained after the suggestion strip's and the request panel's
(`escape: ["chat.strip.hide", "chat.panel.escape", "vi.escape"]`, since a layer's entry stands in
for the base's), and `j k G g` in the code scope; `api.composer.setLabel` for the mode on the
composer's border; the `messageSending` hook to come back to insert mode after each message.

Plugins never reach into each other. What one offers the others is a command, a role (the chat and
code columns), a segment, or data the core holds.

## Agents

The conversation talks to one agent, which a plugin brings: Claude Code's (`plugins/claude.ts`,
the default) or another. `"agent"` in config.json or `--agent <id>` picks it by id; a plugin's agent
is taken up when the plugin registers it, and an id no plugin registered is reported with the ids
there are.

An agent's plugin registers it with `api.agents.register({ id, name, start, send, ... })`. The
core calls its functions for what the user does: `start(options)` (the folder, the model and
session chosen), `send(text, images)`, `interrupt`, `respond(request, reply)` for a request the
user answered, `resume(id)`, `reset` (/new), `setMode`, `setModel`, `setEffort`, `stop`, `kill`,
`sessions(folder)` for the Sessions tab, `loadEarlier` and `loadSubagent(callId)` for a session's
history, `withdraw` for the messages queued that the user takes back (↑ in an empty composer: a
`withdrawn` event gives back those not yet taken up) and `sideQuestion(question)` for /btw (`aside`
events show it and its answer, kept out of the conversation). `choices` says what it offers from the start (`anyModel` for an agent that takes any model
name, as Claude Code takes its aliases). The plugin starts its agent's CLI with `api.process.spawn`
(without Claude Code's `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`, as every agent widecode starts),
writes to it, and reads the agent's files with `api.fs` (a transcript's window, a sessions folder).

What the agent says reaches the conversation as events, a batch per `api.conversation.apply`
call: a message taken up (`take`), a turn opened (`turn`) and ended (`end`, with its time and
cost), text, thinking and calls (`block`, then `text` deltas, `facts`, `input`, `result`,
`finish`), notices, a side question and its answer (`aside`), queued messages given back
(`withdrawn`), requests for the user (`request`: questions, a plan, a permission), the
session's id, model, mode and commands (`session`, `mode`), the tools it has and its MCP servers
(`tools`: each with its server, the name its calls carry, and what the mode lets it do), the
status (`usage`), and the
process's state (`process`: `running`, `ended`). A call's facts are what the views show: its kind
(`category`: read, edit, run, search, fetch, agent, todo, other), its line (`summary`), the files it
touches (`paths`), a command whole, a todo list, the tool it is of when its name is another
(`tool`, so the Available tab counts it). `widecode.d.ts` lists every event and its fields.
A batch happens when it is applied, unless an `at` event says when. Events from an agent the
conversation no longer talks to are dropped.

`plugins/acp.ts` is the one built in: an agent per entry of its section, each spoken to over ACP,
the Agent Client Protocol (JSON-RPC on the agent's stdin and stdout). Another ACP agent is one more
entry, with the command that starts it in ACP mode:

```json
{
  "agent": "opencode",
  "plugins": {
    "acp": {
      "agents": {
        "opencode": { "name": "opencode", "command": ["opencode", "acp"], "sessions": ["opencode", "session", "list", "--format", "json"] },
        "dsh": { "name": "DeepSeek Harness", "command": ["dsh", "--profile", "acp"] },
        "gemini": { "name": "Gemini", "command": ["gemini", "--experimental-acp"] }
      }
    }
  }
}
```

Two agents ship by default: `opencode` and `dsh` (`dsh --profile acp`, the DeepSeek Harness,
installed with `npm install -g @deepseek-ai/dsh`). An entry with the id of a default replaces it.

A session is listed from the agent's `session/list` while it runs and offers it, else from the
entry's `sessions` command, which prints them as JSON. ACP does not say which tools an agent has:
an entry's `tools` command prints them for a mode, named in it as `{mode}` (opencode's default is
`["opencode", "debug", "agent", "{mode}"]`, which prints `{ "tools": { "bash": true, … },
"permission": [{ "permission", "pattern", "action" }] }`), read when the session is ready and again
when its mode changes. The plugin reads the rules as opencode does: a tool whose last rule denies
any pattern is taken from the model, one denied but for some patterns is limited to those, one
asked for asks. An entry with `"midTurn": true` (opencode's) sends a message queued during a turn
into it once a call ends, the agent's next step reading it; else it waits for the turn's end. A
past session is reopened with `session/load` when the agent advertises it (its turns replayed),
else with `session/resume` (its turns not shown): the DeepSeek Harness advertises only the latter,
and neither fork, modes nor deletion, so a side question, a plan mode it does not offer and a
`forget` command do not apply. A side question goes to a fork of the session (`session/fork`, in
plan mode when the agent has one), which the entry's `forget` command deletes after (opencode's
default is `["opencode", "session", "delete", "{session}"]`). An agent that speaks something else
is a plugin of its own over the same `api.agents.register`.

An image is attached by an `@path` typed in the message, or by pasting a path a file manager copied
(a `file://` URI, an absolute path, or one under `~`, quoted or not, one file per line and spaces in
the name included): the path (a png, jpg, jpeg, gif or webp) is read and sent as an image block, and
the text shows it as a numbered chip, `[Image #1]`, in its place (`@widecode/conversation/attach.ts`; the
composer turns a pasted path into the chip as it arrives, `@widecode/chat/composer.ts`). Another file is
left in the text as its path, which the agent reads itself, shown as `[File #N]` while composing. A
press on an image's chip opens the file with the system's viewer (`xdg-open`, `open`, or `cmd
start`). An agent gets one only when it advertised
`promptCapabilities.image` at `initialize`, which it decides from its own configured model: the
DeepSeek Harness advertises it only when its `acp` profile pins an image-capable model, and the
bundle pins the text-only `deepseek-v4-flash`, so an image is refused until the profile's
`cordis.patch.yml` pins `deepseek-flash` (V4.1 Flash). That flag is computed once and does not follow
a later model switch, a text-only model refuses a prompt that carries an image, and a first cold
start can advertise false while the model catalog settles.

## widecode's own tools

A tool widecode offers agents is a plugin's: `api.tools.add({ name, description, input, category,
call, except })`, `input` its arguments' JSON schema, `category` the kind of call it is as the views draw it
(`question` and `plan` show as their request), `call(args)` answering text (another value goes as
JSON) now or as a promise, an error thrown being the call's error, `except` the agent plugins whose
agents do not see it. widecode serves them over MCP, the Model
Context Protocol: `@widecode/agent`'s `McpServer` listens on 127.0.0.1, at a port the system picks, once an
agent's plugin asks where (`api.tools.server()`: the URL, the `Authorization` header with that
plugin's own token, the tools its agent sees with their categories, and a config file naming the
server in Claude Code's `--mcp-config` shape, readable by the user alone, so the token never shows in
a process list). It answers `initialize`, `ping`, `tools/list` and `tools/call`, each for the tools the
token's agent sees; a call waiting on the user
sends a progress notification every 10 s, which keeps the agent's client from timing out. An agent
names a tool after the server, so that it cannot be taken for one of its own: opencode's
`widecode_AskUser`, Claude Code's `mcp__widecode__screen`.

A tool that asks the user calls `api.conversation.ask({ category, questions | plan })`: the
request panel shows it as it shows an agent's, and the promise settles with the reply (`state`
`answered`, `approved`, `declined`, or `cancelled` when the turn ended first).

Which agent sees a tool is decided where the tool is, by one rule: an agent keeps its own tool for a
need, and gets widecode's where it has none. The ask plugin's two carry `except: ["claude"]`, since
Claude Code has AskUserQuestion and ExitPlanMode; every other tool reaches every agent.
`plugins/claude.ts` passes the server's config file with `--mcp-config` when its agent sees a tool,
and a tool added or dropped while the CLI runs (a plugin saved, a reload) is picked up at the end of
the turn, when the CLI stops and the next message starts it again on the same session (Claude Code
reads the tool list once, at start). `plugins/acp.ts` offers the server to an ACP agent that takes
MCP servers over HTTP (`mcpCapabilities.http`), in `session/new` and `session/load`, and draws a
call of a question or plan tool as its request rather than as a call (in the Tools tab, Ask with
its first question, Plan with its plan's first line).

`plugins/ask.ts` brings two: `AskUser` (questions with 2 to 4 choices each, as AskUserQuestion
takes them; the user picks or answers in their own words) and `PresentPlan` (a plan in markdown;
approved while the agent is in plan mode, the agent is switched to its first other mode and a
message asks it to carry the plan out once its turn ends, since an ACP agent's mode holds from its
next prompt). Its section names them: `{ "names": { "question": "AskUser", "plan": "PresentPlan" } }`.

## The harness

A project's `.widecode/` is its harness: what shapes widecode and the agent for that folder, kept
with the code, trusted as one with `/trust` (`src/services/harness.ts`). Its parts:

- `plugins/*.js`: the project's plugins, loaded after the user's and reloaded on save as above.
- `prompt.md`: appended to the agent's system prompt. Before it the core always puts one fixed
  paragraph: that the agent runs inside widecode, what `.widecode/` holds, the tools the server
  `widecode` offers it (by their names for that agent, `mcp__widecode__<name>` for Claude Code) and,
  while the folder is not trusted, that its parts wait for `/trust`. An agent plugin gets the text
  as `AgentStart.systemPrompt`; `plugins/claude.ts` passes it with `--append-system-prompt` and
  `--system-prompt-snapshot off` (Claude Code records the prompt once per session and a resumed
  session would keep the first; off, the prompt the CLI starts with is the one in use).
- `config.json`: the same shape as the user's `~/.widecode/config.json` (`plugins`, `columns`,
  `permissions`), read over it: a `plugins` section named in both is the project's whole, a plugin
  switched off in either stays off, a column's width named in both is the project's; the
  `permissions` lists join as said below.

A folder is trusted as one, the agent and the harness together (`~/.widecode/trusted.json`). In a
folder not yet trusted the agent stays out (a message, a mode change or a resumed session is
refused, saying so) and none of the three parts is in use: the plugins stay out, the config is the
user's, the agent would get the fixed paragraph alone. On the first launch there widecode asks in
the request panel (`src/views/onboarding.ts`), as Claude Code asks for a folder: what the folder
carries that the agent reads (CLAUDE.md, `.claude/` settings, hooks, skills, `.mcp.json`) and that
widecode runs (each harness plugin file with the ids it registers or why it does not load, checked
in a context of its own with nothing run; the prompt's length; the config's keys), and what trusting
means. Trust this folder runs it now and on every launch, Look only keeps the agent out until
`/trust` (the files and the code still show; asked again next launch), Exit leaves. `/trust` puts
everything in use at once, without a reload; `--trust` trusts the folder for one run, nothing asked
and nothing kept (scripts, selftests); without a store (`--ephemeral`) every folder is trusted. The
first run with a store shows the welcome (`/welcome` again) and asks, before the folder, which
agent to talk to (`/agent` later, kept in config.json) and which model a session starts on, and
after it which keymap to use.

The folder is watched (the project folder itself until `.widecode/` appears), and each part applies
on its own: a plugin file reloads alone; `config.json` saved re-reads the config, starts again the
plugins whose section or on/off changed and re-sizes the columns, nothing else; `prompt.md` saved
fires the `harnessChanged` hook, which the Claude plugin takes as a tool change: the CLI stops at the
turn's end, if no message was written during the turn, and the next message starts it again on the
same session with the new prompt. So an agent asked to change the harness writes the files with its
own tools and sees each take effect while its turn runs, the prompt from its next turn.

The harness plugin (`plugins/harness.ts`) gives the agent seven tools over widecode's MCP server,
`mcp__widecode__<name>` for Claude Code, `widecode_<name>` for opencode: `screen` (the screen as
drawn, every column but the chat unless named, since the chat holds the agent's own text), `state`
(the columns, the tabs, every plugin with its state, the last plugin errors, the harness folder),
`log` (the last lines of the log), `api` (the plugin guide and the API's types as the binary carries
them, whole, one part by name, or looked up), `check` (a plugin source evaluated in a context of its
own with nothing registered: its plugins, errors and warnings), `reload` (a plugin file evaluated
again, answering what it defined and the errors it raised) and `config` (the configuration in use
and where each part came from). The fixed paragraph names them. An agent asked to change widecode
reads `api`, checks and writes the file, and reads `log` and `screen` to see the effect; the core
calls behind the tools are `plugins`, `harness` and `state` in the API table, and
`scripts/builtin-plugins.mjs` embeds PLUGINS.md and `widecode.d.ts` into `src/runtime/docs.ts` for `api`,
since the installed binary ships without the repository.

### Tool permissions

`permissions` in either config.json holds tool rules in Claude Code's own syntax, `{ "allow": [],
"ask": [], "deny": [] }`: `Bash(git push *)`, `Read(./.env)`, `WebFetch(domain:example.com)`,
`mcp__widecode__reload` (the rules' grammar is Claude Code's "Configure permissions" page). The
Claude plugin passes the lists to the CLI with `--settings`, and the CLI enforces them: a deny rule
blocks the call in every mode, bypass included; an ask rule prompts in every mode, and the prompt
reaches widecode over stdio as a `can_use_tool` request; an allow rule has no effect under bypass. The
user's rules come first: the project's `ask` and `deny` lists join the user's, the project's `allow`
is left out (a project adds restrictions and cannot lift the user's), and the user's own
`~/.claude/settings.json` applies as the CLI reads it. A change to either file reaches the CLI at the
turn's end, through the same stop and `--resume` as a prompt change.

A `can_use_tool` for a tool that is not a question or a plan is a permission the request panel puts
to the user: the tool and its argument (a command, a path, a pattern, a URL), with Allow once (the
call runs), Allow for this session (the same tool with the same argument runs again without asking
while widecode runs), Allow all for this session (this call and every later prompt are allowed
without the panel until /new or another session is opened, plan mode included; the prompts open
beside it are allowed with it and show as answered; a question and a plan to approve are still
asked) and Deny (the CLI is told the user denied the tool). Esc or the turn ending denies. Under
bypass the CLI asks only what no mode auto-approves (an ask rule, a critical-path removal, an MCP
tool that needs the user); in a mode that asks (plan mode is one), every prompt comes to the panel.

A prompt about a path outside the session's folders (in a mode that asks, a `cd` into another
repository or a read of a file there; the CLI names the path as `blocked_path`, or `workingDir` as
the reason) adds two answers before Allow all, for the git repository holding the path (else the path's
own folder, never the home folder or the root). Allow <folder> for this session runs the call and
adds the folder to the session's (`updatedPermissions` `addDirectories`), so reading there stops
asking; widecode passes it again with `--add-dir` to each start while it runs. Allow <folder> from
now on does the same and has the CLI keep the folder in the project's
`.claude/settings.local.json` (`permissions.additionalDirectories`), which later sessions read.

`/harness` says what the folder's harness holds, in the chat: trusted or not, each plugin file with
its plugins' states, the prompt's length, the config's keys, the tools the agent sees, the last
plugin errors. `/harness init` writes the skeleton where a file is missing: `prompt.md` (two lines
to replace), `plugins/example.js` (a tab and a command), `config.json` (empty `plugins` and
`columns`), and `.claude/skills/widecode/SKILL.md`, the skill Claude Code loads in the folder when
asked to change widecode: the loop (`api`, `check`, write, `reload`, `log` and `screen`), what a
plugin can and cannot do, the tools, the permissions' shape. Written in an untrusted folder, the
files wait for `/trust`.

## Limits

- Every value crosses into the core as JSON: a plugin passes and keeps plain data, and what the
  core answers later (git, processes) comes as a promise.
- Every file runs as a function body in one shared context: its top-level names are its own, but a
  write to `globalThis` reaches every plugin and outlives a reload of the file (only `/reload`, a
  fresh context, clears it).
- A call into a plugin has 250 ms; an agent's history read (`resume`, `loadEarlier`,
  `loadSubagent`) has 2 s. Past it the plugin is switched off with everything it added, and
  widecode says so; the time the core spends answering does not count, and a command one plugin
  runs for another has a budget of its own.
- An error in a plugin's function is reported (the log, the status bar) and the plugin goes on.
- The plugins share 64 MB, and a plugin can recurse about 230 calls deep before a RangeError.
- Heavy work stays native: diffs, the tree, git, rendering the conversation. A plugin decides what
  to show and when, and draws rows for the visible window.

## Settings and kept state

```json
{
  "log": { "enabled": true, "keep": 30 },
  "plugins": {
    "git": false,
    "models": { "list": ["opus[1m]", "fable[1m]"] },
    "sessions": { "titles": true, "titleModel": "haiku" },
    "status": { "separator": " │ ", "lines": [["project", "context", "cost", "title"]] }
  }
}
```

`"log"` is the run's log, a file per run under the store's `logs/` (`/log` says which): `false`
turns it off, `"dir"` moves it, `"keep"` is how many runs' files stay. Everything a plugin notes
(`api.note`) and every status message goes there, with the run's start, its sessions and turns, how
it ended, and an uncaught error with the trail of what ran last (a key, a plugin's call, a frame's
phase, the agent's events) and the screen as it was.

## The built-in plugins

| id | Contributes | Settings | Kept |
|---|---|---|---|
| `chat` | the chat column (the core's chat widget: ↑↓ through the folder's messages, ↑ in an empty composer taking back the messages queued, Ctrl+K copies what it cuts); `/new /compact /quit /exit /plan /open /btw`; Shift+Tab, Ctrl+Home/End; each message carries its label, `[12:13:00 12/03/2026] <Me>: …` and `<the agent>: …`, the date in the user's locale | | |
| `code` | the code column (the core's code widget); `n p w f`, Esc back from a commit's file, a subagent or a call; following Claude's edits; a resumed session's file opened again | | wrap; the file shown, in the session's record |
| `tools` | the Tools tab of the tools column (the core's tools widget): Claude's calls with their clocks, one shown whole in the code column; the chat's "· N tools" lines show theirs there. The Available tab: the tools the agent has, by source, with what the mode lets each do and its calls | | |
| `files` | the Files tab; `c`; `/files` | | the switch |
| `sessions` | the Sessions tab, a chosen session's details in the code column, Enter opening it here and t in a new terminal; `/resume /rename /title`, F4; the title policy | `titles`, `titleModel`, `terminal` | |
| `git` | the Git tab; `b` and the compare base; a session's starting commit | | |
| `peers` | the Peers tab and segment: this machine's shared repositories, each paired machine with every repository it offers and how this machine's copy stands against it (↓ commits to fetch, ↑, level, not here), the machines nearby (mDNS through avahi or dns-sd), pairing, fetch, clone, hosted bare repositories peers push into, a page in the code column with a repository's commits to fetch, `/peers` | `autoFetch`, `refreshMs` | the daemon it starts |
| `agents` | the Agents tab of the tools column: the session's subagents, one's steps shown in the code column | | |
| `changes` | the changes strip of the band, under the code column; `[ ]`, Alt+↑↓ | | |
| `status` | the session table under the chat and the calls' under the tools column, their segments and command cells | `separator`, `lines`, `toolsLines` | |
| `models` | F5, `/model`, `/effort`, the `model` segment | `list` (Claude Code's), `agents` (another agent's, by id), `effort` (`default`, by `providers`, by `models`) | the model chosen, by agent; the effort chosen, by model, provider and overall |
| `claude` | Claude Code as the agent: its CLI over stream-json, its records read into the conversation, its transcripts resumed and listed, its status line data | `id`, `projects` | |
| `acp` | the agents spoken to over ACP, opencode and the DeepSeek Harness by default: their session, started with widecode, their turns, calls, diffs, todo lists, subagents, permissions, model, effort and mode (config options), and sessions; widecode's MCP server offered to them | `agents` | sessions made and not written to, deleted when left |
| `ask` | widecode's tools for an agent without its own: `AskUser` (questions in the request panel), `PresentPlan` (a plan to approve, leaving plan mode) | `names` | |
| `harness` | widecode's tools for the agent to probe and reshape widecode itself, over the MCP server: `screen`, `state`, `log`, `api`, `check`, `reload`, `config` (The harness, above) | | |
| `languages` | JavaScript, TypeScript, JSON, CSS, HTML, Markdown | | |
| `emacs` | the emacs keymap, in use unless config.json or /keymap says otherwise: Ctrl+F/B, Ctrl+P/N, Alt+D, Alt+< and Alt+>; the composer has readline's other keys already | | |
| `vi` | the vi keymap (`/keymap vi`): insert and normal modes in the composer (Esc between them, the border saying which), motions, operators with counts, a register, undo; j k gg G in the code column | | |

## A worked example

`~/.widecode/plugins/notes.js`: a command, a key in the code column, a status segment and a tab.

```js
widecode.plugin({
  id: "notes",
  requires: ["code"],
  activate(api) {
    const notes = [];
    const tab = api.ui.panel({
      id: "notes",
      title: "Notes",
      order: 5,
      count: () => notes.length,
      rows: (from, count) => notes.slice(from, from + count).map((n) => " " + n),
      info: () => [{ text: " " + notes.length + " notes", fg: "gray" }],
    });
    api.commands.add({
      name: "/note",
      usage: "<text>",
      help: "keep a note",
      run: (text) => {
        notes.push(text);
        tab.refresh();
      },
    });
    api.keys.add("char:z", "code", "z note the file", () => {
      notes.push(api.code.path());
      tab.refresh();
      return true;
    });
    api.ui.segment({ name: "notes", draw: () => [{ text: notes.length + " notes", fg: "#61afef" }] });
  },
});
```

Saved, it loads at once. The status table shows its segment once config.json names `"notes"` in a
line of the status section.

## Writing a built-in plugin

A built-in plugin is `apps/widecode/plugins/<id>.ts`, ending with `export {};`, typed against
`widecode.d.ts` (`npm run check`). What it needs from the core is a call in the prelude
(`src/runtime/prelude.ts`), its answer in its namespace's `src/api/<file>.ts` and its type in
`widecode.d.ts` (`test/api.test.ts` checks the three agree). Its tests
drive it through the app (`createWidecode`) and carry `// ffi: apps/widecode/native/ffi.json` on
their first line, so they run natively with QuickJS and under node with the stand-in.
