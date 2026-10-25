# widecode

widecode and its desktop chat, native apps on [`light`](https://github.com/alantriesagain/light)
compiled by scriptc into static binaries with **no JavaScript engine** (no Node, Bun or Deno at
runtime). A pnpm workspace that links light: `light` is the checkout beside this one (`../light`
on `main`, consumed as `@bootstrapp/light`), and light's packages for native apps (`@light/<name>`,
light's `packages/README.md`) are members here too; `packages/*` are what these apps share
(`@widecode/<name>`), `apps/*` the apps, each member with its own package.json declaring what it
imports; `light-native` (`@light/cli`) builds, runs and gates them. `AGENTS.md` has the rules for
working here, light's `packages/native/cli/README.md` the commands.

The apps: widecode, a Claude Code frontend for wide terminals (chat, tools, files and code side by
side over one folder, a native core and JavaScript plugins in an embedded QuickJS), and the chat as
a desktop app on light's desktop shell. Claude is reached through the user's installed Claude Code
CLI as a sidecar over `stream-json`, or any agent speaking ACP.

Light's TypeScript core needs scriptc patches no release carries yet (`unknown`-typed class
fields, native dispatch for generic classes, and more; the fork's `FORK.md` lists them), so
`light-native` compiles with the scriptc named by `SCRIPTC`, else the fork's `scriptc-dev` on PATH, else the one
installed at the root:

```
SCRIPTC=/path/to/scriptc pnpm test
```

## Build and run

Prerequisites: Node 24+ and pnpm (only to run the tooling and the compiler), a C compiler (`cc`),
Claude Code installed and logged in (`claude` on PATH), and light checked out beside this
directory at `../light` on the `main` branch (`pnpm install` there once).

```
pnpm install                    # links light, its packages and these; typescript and @types/node (dev only; zero runtime deps)
pnpm typecheck                  # tsc per member (light-native typecheck --all)
pnpm test                       # every member's tests under node AND as native binaries; outputs must match (light-native test)
pnpm coverage                   # scriptc coverage gate: every app entry and test compiles statically (light-native coverage)
scripts/lint.sh                 # no em dashes or any types in app/package text
scripts/ci.sh                   # the CI gate: lint, verify, build, and the three widecode selftests
pnpm light-native build widecode         # apps/widecode/dist/widecode (stripped)
pnpm light-native test widecode -- chat.test.ts   # one member, one test
```

The chat as a desktop app (light's desktop shell: the backend compiled by scriptc, the chat screen
as a light page in the system's web view, WebKitGTK on Linux):

```
pnpm desktop                        # builds apps/desktop/dist/harness-desktop and its page, then opens the window
pnpm light-native desktop desktop --selftest # end to end: the page connects, a turn runs against claude, exit 0 on its result
```

Needs light's desktop prerequisites (`libwebkit2gtk-4.1-dev`, `g++`) and a display; the built app
(3.3 MB) needs only the runtime WebKitGTK a desktop already has. The shell, the bridge and its rules are
documented in light's `native/desktop/README.md`.

A Claude Code frontend in the terminal, `apps/widecode` (chat | tools | files | code over one
folder: sessions of the folder listed and resumed, interrupts, plan mode, questions and plan
approvals answered in the TUI, model and effort per session, `@` file completion and images attached
by path, Claude's tool calls and subagents in a column of their own, and the code column showing
the file Claude edits with its changes against HEAD). The first run welcomes you and asks which
agent to talk to, which model, and which keys to use (default, emacs, vi). A folder is used once you
trust it: the first launch there asks, with what the folder carries, as Claude Code does. A folder's
`.widecode/` is its harness: plugins, a prompt appended to the agent's, a config over the user's,
run once the folder is trusted; `/harness init` writes its skeleton and a skill, and the agent
reshapes widecode from inside through widecode's own tools (`apps/widecode/PLUGINS.md`, "The
harness"):

```
pnpm light-native install widecode                      # builds it and installs it as `widecode` in ~/.local/bin; then `widecode` in any folder
pnpm widecode                                  # builds apps/widecode/dist/widecode, then runs it in the current folder
pnpm widecode -- --no-build --resume ID        # resume a session of the folder
pnpm widecode -- --agent opencode              # talk to opencode over ACP instead of Claude Code
pnpm light-native selftest widecode shell               # in a pty on a temp repo: tree, diff, a write followed within 1 s
pnpm light-native selftest widecode fake                # a turn against a fake CLI replaying recorded traffic
pnpm light-native selftest widecode fake-acp            # a permission and a question over widecode's MCP server, answered from the panel, against a fake ACP agent
NATIVE_LIVE=1 pnpm light-native selftest widecode live-turn   # also live-interrupt, live-ask, live-plan, live-agent, live-edit, live-quit
NATIVE_LIVE=1 pnpm light-native selftest widecode live-acp    # opencode over ACP runs a command and replies (its free model); also live-acp-ask, live-acp-plan
```

In the app: Enter sends (queued while Claude works; ↑ in an empty composer takes the queued messages
back to edit), Alt+Enter adds a line, Alt+←/→ (or Alt+b, Alt+f) move by a word, Ctrl+D deletes
forward, Ctrl+K, Ctrl+U and Ctrl+W kill (Ctrl+Y yanks the last kill back), Ctrl+/ undoes, Esc
interrupts,
Shift+Tab toggles plan mode, `@` completes a path (Tab takes it; `@image.png` attaches the image),
`/resume`, `/new`, `/compact [instructions]`, `/model <name>`, `/effort <level>`, `/plan`,
`/btw <question>` (a side question, answered in the chat and kept out of the conversation),
`/keymap <name>` (the keys in use: emacs unless told otherwise, with Ctrl+F/B/P/N and Alt+D beside
readline's; default, readline's alone; or vi, with insert and normal modes in the composer, Esc
between them; kept for the next run),
`/help`, `/quit`; F1 (chat), F2
(files), F3 (code), F6 (tools) or Ctrl+←/→ switch columns, the wheel scrolls the column under the
pointer and PgUp/PgDn the active one; a pane longer than its rows has a scrollbar at its right edge
(drag the thumb, or press the track to bring the thumb there); a drag on the border between two
columns resizes them (kept for the next run; `/columns` says the widths, `/columns reset` forgets
the drags); a press on a thinking line shows its words; Ctrl+C clears the message, and quits when it is empty (twice while Claude works); `/open <folder>` switches folders; F12
writes the screen's text to the log. New sessions run on Opus 5.5 with the 1M context
(`opus[1m]`); F5, or a press on the model in the status bar, switches to Fable (`fable[1m]`) and
back, live (`"models": [...]` in the config lists what F5 cycles; a session resumes on the model it
last ran on). The model chosen (F5, `/model`) is the agent's default from then on, and the effort
chosen (`/effort`) is kept for the model, for its provider (the part of its id before "/", else the
agent) and overall: a model switched to gets the effort last chosen for it, else for its provider,
else anywhere, when the agent offers it. `--model` and `--effort` hold for their launch. The chat holds the messages and Claude's replies (and its thinking, one line each);
the calls Claude made between two replies are one dim line (`· 3 tools · Read ×2, Bash`, one call
`· Bash npm test`) whose press shows them in the Tools tab. While Claude works, the chat's last line
says what it is doing (starting, thinking, writing, the tool it runs, compacting), for how long this
step and the turn, over the messages queued for it; a message sent while Claude is idle shows as
sent at once. After `/compact`, the chat says how much context it freed and the context meter drops
at once.

The tools column, right of the chat, has three tabs. Tools: every call, under the message it answers,
each with where it stands (a spinner while it runs, then ● done, failed or stopped), what it was
given, and how long it took (its clock moving while it runs); ↑↓ and Enter or a press show a call
whole in the code column: its command or input, and its output or change (Esc returns to the file).
Available: the tools the agent has, its own first, then each MCP server's (widecode's own among
them) with where the server stands, each with its calls this session; Claude Code says them when
it starts, an ACP agent through its entry's tools command (opencode's `opencode debug agent
<mode>`, read again when the mode changes, whose permission rules say what the mode denies, limits
to some files or asks for: in plan mode, edit and write only on plan files). A press on a tool says
all of that in the status bar. Agents: the session's subagents, where each stands and what it is
doing or reported; a press shows one's steps in the code column, live while it runs.

The files column has three tabs, their links on the band under it (a press on one, or Tab in the
column; F4 or `/resume` opens Sessions). Files: an All │ Changed switch (a press, or `c`), then the tree, changed names in their
change's color. Sessions: the folder's sessions, ↑↓, Enter resumes (with the file the code column
showed in it), `n` starts a new one; the terminal's title follows the session's. Git,
read-only: what the changes are compared with (`b` cycles: HEAD; where this branch left the main
branch; where this session started, recorded with its first message), the branches (ahead and behind
their upstream), and a branch's log with this session's commits marked ●; a commit opens to its
files, a file shows that commit's change in the code column (Esc returns to the work tree). The code
column shows the file with its changes in place (a new file as plain code), colored (JavaScript, TypeScript, JSON, CSS, HTML,
Markdown with its fenced code), `n`/`p` between changes, `f` to stop or resume following Claude's
edits, and `w` or the box at its foot to wrap long lines (at a space, under their own indentation).

In the composer, ↑ on its first line walks back through the messages written in this folder (kept
in `.widecode/history.jsonl`, rotated aside past 4 MB, nothing dropped) and ↓ comes forward to the
message being written; Ctrl+K cuts to the line's end and copies what it cut. A drag in the chat,
the code column or a tab selects, and its release copies the selection (the code column copies the
file's own text, without line numbers). Copying asks the terminal through OSC 52, or runs xclip,
xsel or wl-copy where the terminal does not take OSC 52 (VTE's, as Guake and GNOME Terminal);
config.json's `"clipboard"` (`"auto"`, `"osc52"`, `"xclip"`) decides otherwise.

The columns' widths follow the terminal's: the chat two fifths, the tools column a seventh (32 to 44
cells), the files column what its tab asks for (Files 24 to 30, Sessions 24 to 48, Git 34 to 60),
the code column the rest. config.json's `"columns"` sets them, in cells or as a share of the
terminal: `{"chat": "35%", "tools": 40, "files": 30}` (the code column takes the rest). A border
dragged wins over the config until `/columns reset`; when the code column would get under 20 cells,
the others give way.

Under the columns, the status band, in parts as wide as the columns above. Under the chat, the
session as a table (the config's lines are its rows; cell i of each row as wide as the widest, so
like things stack; each row's last cell, the text, grows): folder, model and effort, mode; context
and the 5-hour and weekly limits as meters; cost, time, cache; then the title and the app's
messages. Under the tools column, its tabs' links, and beside them what Claude is doing and for how
long (✻ while it thinks), the calls by kind (read, write, run, agents), and the calls and thinking
tokens. Under the files column, the tabs' links with their counts. Under the code column, the
changes (the branch among them): how many files and lines against the
base, the open file and where its view is among its changes, then every changed file newest first
with its lines added and removed, how long ago it changed, ● when Claude edited it; a press opens
one, and `[` `]` (files and code columns) or Alt+↑↓ (anywhere) walk them.

widecode is a native core and JavaScript plugins, one per feature (the chat and code columns'
wiring, the Tools, Agents, Files, Sessions and Git tabs, the changes and status bars, the models,
the languages),
running in an embedded QuickJS. Each can be switched off in config.json or replaced: a `.js` file in
`~/.widecode/plugins/` with a built-in's id overrides it, a new one adds a feature, and a project's
own `.widecode/plugins/` run once the folder is trusted. Saving a plugin reloads the plugins, as
`/reload` does. `apps/widecode/PLUGINS.md` has the API and how to write one, and `widecode.d.ts`
types it.

The conversation talks to an agent a plugin brings, Claude Code's by default (`plugins/claude.ts`,
its CLI over stream-json); config.json's `"agent"` or `--agent <id>` picks another. The `acp` plugin brings the agents that speak ACP, the Agent
Client Protocol, opencode among its defaults (`opencode acp`); another one is an entry in its
section with the command that starts it (`"gemini": {"command": ["gemini", "--experimental-acp"]}`).
Their turns, calls with their diffs, plans, permissions (answered in the request panel), modes and
sessions show as Claude Code's do; titles Claude writes are for Claude Code's sessions only. An ACP
agent's session starts with widecode, so its models and efforts can be chosen before the first
message; a session made and never written to is deleted (the entry's `forget` command) when it is
left. An ACP
agent that takes MCP servers over HTTP gets widecode's own tools (`plugins/ask.ts`): `AskUser`
puts its questions in the request panel and `PresentPlan` its plan, which approved in plan mode
switches the agent out of it and asks it to carry the plan out. Claude Code keeps its own tools for
these.

widecode keeps a project's sessions in the project, in `.widecode/sessions/<id>.json` (each
session's title, model, cost across CLI processes, thinking tokens, the commit it started on), so
the Sessions tab lists every session of the folder; `.widecode/` holds a `.gitignore` of `*`, so git
leaves it out. Settings live in `~/.widecode` (or `$WIDECODE_HOME`): `config.json`, a `"plugins"`
object with a section per plugin (`false` switches it off; written with every plugin's defaults on
first run) and `"keymap"`, `keys.json` (the user's key bindings over the keymap: by scope, a key to
the action it runs, or null for none; `/help` names the actions and their keys), `state.json` (what
is kept between runs: the code column's wrap, the Files switch, the widths columns were dragged to,
the keymap /keymap chose),
`limits.json` (the last 5-hour and weekly limits seen) and `logs/`, a file per run (`/log` says
which; the newest 30 kept) with the build, the flags, the sessions and turns, every five minutes
that it is alive, how it ended, and an uncaught error with the trail of what ran last and the screen
as it was, so a crash can be read afterwards (`"log": false` turns it off, `{"dir": "~/x",
"keep": 10}` moves it, `--log <path>` names one file, `--no-log` none); the first run moves an
earlier `~/.ctui` over, and a config.json from before plugins has its keys moved under `"plugins"`
once. A session
gets a short title written by Claude after its first turn (a separate call: haiku, no tools, nothing
saved; `"sessions": {"titles": false}` turns it off); `/rename` sets one, `/title` asks again. The
status tables are the status plugin's section, `{"separator": " │ ", "lines": [[...], ...],
"toolsLines": [[...], ...]}` (the one under the chat, the one under the tools column): each line
lists its cells, a cell being a segment (`project branch model effort mode title context
limit5h limitWeek cache activity tools calls thinking cost duration queued note`, or one another
plugin registers; `spacer` pushes the cells after it to the right edge), a list of them (joined by "
· "), an object that restyles one (`{"segment": "cost", "fg": "#98c379", "label": "spent"}`), or a
command (`{"command": "~/.claude/statusline.sh", "interval": 5}`) that gets Claude Code's status
line JSON on stdin, so Claude Code status line scripts work as they are (a line that is only a
command shows every line it prints); `apps/widecode/examples/statusline.sh` is one. F5 cycles the
models plugin's `"list"` (`"agents"` holds another agent's, by its id; its `"effort"` holds the
efforts to start from, `"default"`, by `"providers"` and by `"models"`, under those chosen). Typing `/model` lists the
agent's models above the composer, narrowed by each word typed (`/model dee pro`); ↑↓ choose and
Enter switches. A command's name completes the same way after "/", and `/effort` its levels. The CLI protocol it relies on, measured with recorded fixtures, is in
`apps/widecode/PROTOCOL.md`; the manual checklist, driven in a pseudo-terminal, is in
`apps/widecode/test/checklist/`.

Other commands: `pnpm probes` runs the compiler probes into `probes/RESULTS.md`.

## Peers: the machines on your network

widecode shares a machine's repositories with the machines paired with it over the LAN, in place and read-only, and the other side fetches. Each machine runs one daemon (`widecode --peers-daemon`, started by the app when the bridge is in use or asked for) that serves git's smart HTTP protocol out of the shared checkouts, announces itself over mDNS (avahi on Linux, dns-sd on macOS) and keeps a registry under `~/.widecode/peers/`: its keypair, the peers it paired with and their tokens, what it shares. Nothing is written into a repository, and a working tree is never touched: a fetch writes refs.

Pairing is a six-digit code: `/peers pair` shows one here for two minutes; `/peers join <host:port> <code>` (or a nearby machine's name) on the other machine exchanges keys and mutual tokens. `/peers share` shares this folder's repository (at its root, every local branch and tag; the registry keeps a branch filter and an allow list per repository), and `/peers share <path>` another checkout of this machine. A paired peer's copy of this repository is matched by root commit and set up as a remote named after the peer, its token in the local git config (`http.<url>.extraHeader`, never in a URL); the plugin fetches it when the peer appears and every two minutes, so the Peers tab and the Git tab say how far ahead or behind each copy is. `/peers host <name>` makes a bare repository under the store that paired peers may push into (`/peers host /path/to/repo.git` hosts one that exists), fetched and pushed at `/h/<name>`; a live checkout is fetched at `/r/<rootCommit>`.

The Peers tab (beside Git) lists this machine and its shares, the paired peers with what they offer and the machines nearby not paired yet, and the pairing code; Enter fetches, `s` shares or unshares, `p` pairs, `x` forgets, `r` reads again. The status bar's `peers` segment says how many peers are online, or which one is ahead. Requests from outside the private address ranges are refused; a forgotten peer's token stops working at once. A machine's firewall must let the port in (`sudo ufw allow 7337/tcp` on a Linux box with ufw; macOS asks on the first start when its firewall is on): a peer that cannot be joined or fetched from, while it sees this one, has it closed. The daemon's flags: `--port` (7337 by default), `--name`, `--bind`, `--no-discovery`; the plugin's section of config.json: `autoFetch`, `refreshMs`.

## Layout

| Directory | What it is |
|---|---|
| `light/packages/native/*`, `light/packages/tui/*` | light's packages: `@light/cli` (`light-native`, the tooling: `prepare`, `build`, `run`, `selftest`, `test`, `coverage`, `typecheck`, `check`, `probes`, `install`, `desktop`), and `lib`, `highlight`, `plugins`, `workspace`, `test`, `kernel`, `ui`, `markdown`: what the core's modules share; the tokenizers; the embedded JavaScript; a folder's files and git; the tests' helpers; the plugin kernel; the palette and the windowed list; Markdown as lines (light's `packages/README.md`) |
| `packages/agent`, `conversation`, `screen`, `code`, `chat` | the `@widecode/*` packages, each with its README: the `claude -p` sidecar and the MCP server; the conversation with an agent; the screen plugins contribute to; the code column; the chat views |
| `apps/widecode` | the Claude frontend, a native core and JS plugins (`PLUGINS.md`): `plugins/<id>.ts` (the built-in plugins: chat, code, tools, agents, files, sessions, git, changes, status, models, languages, and the agents' claude and acp), `widecode.d.ts` (the plugin API's types), `src/` (controllers, views, the plugin runtime and the API's answers, the store and the harness folder), `test/` (its tests, fixtures, fakes and goldens) |
| `apps/desktop` | the desktop app: `contract.ts` (the bridge's methods and events, imported by both sides), `src/main.ts` (the backend: a `DesktopApp` on light's desktop host with the Claude sidecar as `AgentService`, `--selftest`), `web/` (the page: one light component, its importmap) |
| `probes/` | the proof of concept's scriptc experiments and the rules they produced (`probes/README.md`), `p0-workspace/` the probe of the workspace's import route; light's `native/probes/` continues them |

A component:

```ts
class Counter extends View {
  readonly count = signal(0);
  override render(): unknown {
    return html`<div border title="Counter">
      <p>Count: <b>${() => this.count.value}</b></p>
    </div>`;
  }
}
```

A signal read in `render()` re-renders the view; one read in a thunk (`${() => …}`) recommits
that part. Tags read like HTML (`div`, `p`, `b`, `textarea`, …) and map onto the terminal's
`box`, `text`, `span` and `input`; light's `native/tui/README.md` lists the props and events (`@key`,
`@submit`, `@change`, `@click`, `@wheel`, `@focus`, `@blur`). A handler receives the event and no
`this`.

## Rules the code follows (scriptc static mode)

Light's `native/probes/README.md` is the current list; the ones the harness itself meets:

- No `any`; dynamic data is `unknown` plus checked casts (`JSON.parse(s) as { type: string }`
  validates at runtime and ignores extra keys).
- Anything that needs identity is a class; a class instance keeps that identity through `unknown`,
  not through a parameter typed with its base class.
- Callbacks are nullable function fields (`onEvent`, `onSubmit`), not a generic emitter class: a
  generic class with methods in its own module lost them natively beside light's template engine.
- A function-typed field must not share its name with any method anywhere in the program.
- Erasable TypeScript syntax only, so the same `.ts` runs under `node` for fast feedback.

## How it talks to Claude

The npm Agent SDK is a wrapper that spawns the Claude Code binary (a ~240 MB Bun executable), so
it cannot be embedded engine-free. The harness spawns the user's installed `claude` with
`-p --input-format stream-json --output-format stream-json --include-partial-messages --verbose`,
writes `{"type":"user","message":{"role":"user","content":"…"}}` lines, and decodes the output
envelopes (`system/init`, `stream_event` text deltas, `assistant`, `result`). Built-in tools are
disabled (`--tools ""`) unless `--tools` is passed. Each user authenticates with their own
Claude Code login; the binary is never bundled.
