# widecode

widecode, a native app on [`light`](https://github.com/alantriesagain/light) compiled by scriptc
into a static binary with **no JavaScript engine** (no Node, Bun or Deno at
runtime). The repository root is the app, in a pnpm workspace that links light: `light` is the
checkout beside this one (`../light` on `main`, consumed as `@lightstart/light`), and light's
packages for native apps (`@lightstart/<name>`, light's `packages/README.md`) are its other members;
`light` (`@lightstart/native`) builds, runs and gates it. `AGENTS.md` has the rules for
working here, light's `packages/native/README.md` the commands.

widecode is a Claude Code frontend for wide terminals (chat, tools, files and code side by side over
one folder, a native core and JavaScript plugins in an embedded QuickJS). Claude is reached through the user's installed Claude Code
CLI as a sidecar over `stream-json`, or any agent speaking ACP.

The compiler is the scriptc release pinned in `package.json` (0.4.12), installed at the workspace
root and run under node by `tools/scriptc-node` (npm's native `scriptc` binary segfaults on the app's
entry, vercel-labs/scriptc#3595); `light` compiles with it, and `SCRIPTC` names another:

```
SCRIPTC=/path/to/scriptc pnpm test
```

## Build and run

Prerequisites: Node 24+ and pnpm (only to run the tooling and the compiler), a C compiler (`cc`),
Claude Code installed and logged in (`claude` on PATH), and light checked out beside this
directory at `../light` on the `main` branch (`pnpm install` there once).

```
pnpm install                    # links light, its packages and these; typescript and @types/node (dev only; zero runtime deps)
pnpm typecheck                  # tsc (light typecheck)
pnpm test                       # every test under node AND as a native binary; outputs must match (light test)
pnpm coverage                   # scriptc coverage gate: the entry and every test compile statically, failing on blockers (light coverage)
pnpm light build         # dist/widecode (symbols kept; --strip to drop them)
pnpm light test -- chat.test.ts   # one test
```

A Claude Code frontend in the terminal (chat | tools | files | code over one
folder: sessions of the folder listed and resumed, interrupts, plan mode, questions and plan
approvals answered in the TUI, model and effort per session, `@` file completion and images attached
by path, Claude's tool calls and subagents in a column of their own, and the code column showing
the file Claude edits with its changes against HEAD). The first run welcomes you and asks which
agent to talk to, which model, and which keys to use (default, emacs, vi). A folder is used once you
trust it: the first launch there asks, with what the folder carries, as Claude Code does. A folder's
`.widecode/` is its harness: plugins, a prompt appended to the agent's, a config over the user's,
run once the folder is trusted; `/harness init` writes its skeleton and a skill, and the agent
reshapes widecode from inside through widecode's own tools (`PLUGINS.md`, "The
harness"):

```
pnpm light install                      # builds it and installs it as `widecode` in ~/.local/bin; then `widecode` in any folder
pnpm widecode                                  # builds dist/widecode, then runs it in the current folder
pnpm widecode -- --no-build --resume ID        # resume a session of the folder
pnpm widecode -- --agent opencode              # talk to opencode over ACP instead of Claude Code
pnpm light selftest shell               # in a pty on a temp repo: tree, diff, a write followed within 1 s
pnpm light selftest fake                # a turn against a fake CLI replaying recorded traffic
pnpm light selftest fake-acp            # a permission and a question over widecode's MCP server, answered from the panel, against a fake ACP agent
pnpm light selftest harness             # widecode's own agent on its fake model: a command and a reply, then AskUser answered from the panel
NATIVE_LIVE=1 pnpm light selftest live-turn   # also live-interrupt, live-ask, live-plan, live-agent, live-edit, live-quit
NATIVE_LIVE=1 pnpm light selftest live-acp    # opencode over ACP runs a command and replies (its free model); also live-acp-ask, live-acp-plan
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
(files), F3 (code), F6 (tools) or Ctrl+←/→ switch columns, F10 opens the menu bar, the wheel scrolls the column under the
pointer and PgUp/PgDn the active one; a pane longer than its rows has a scrollbar at its right edge
(drag the thumb, or press the track to bring the thumb there); a drag on the border between two
columns resizes them (kept for the next run; `/columns` says the widths, `/columns reset` forgets
the drags); a press on a thinking line shows its words; Ctrl+C clears the message, and quits when it is empty (twice while Claude works); `/open <folder>` switches folders, starting the app again there with the same agent, model and effort; F12
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

The files column has five tabs on its top edge (a press on one, or Tab in the
column; F4 or `/resume` opens Sessions). Files: an All │ Changed switch (a press, or `c`), then the tree, changed names in their
change's color. Sessions: the folder's sessions, ↑↓, Enter resumes (with the file the code column
showed in it), `n` starts a new one; the terminal's title follows the session's. Git,
read-only: what the changes are compared with (`b` cycles: HEAD; where this branch left the main
branch; where this session started, recorded with its first message), the branches (ahead and behind
their upstream), and a branch's log with this session's commits marked ●; a commit opens to its
files, a file shows that commit's change in the code column (Esc returns to the work tree). Peers:
the LAN git bridge (below). Skills: the skills the agent has (the project's and the user's read from
disk at launch, Claude Code's own once it starts; an ACP agent's from its entry's skills command,
opencode's `opencode debug skill`), by where each comes
from (the project's `.claude/skills`, the user's, a plugin's, the agent's own), with what each SKILL.md
says it is for, how many times it ran this session and how many in the project across sessions and
agents (each run that ended is kept in `.widecode/skills.jsonl`); above them the session's skill
runs, newest first, each with where it stands, the calls the turn made after the skill and for how
long, live while one runs. A press on a skill also says how many of the project's runs were typed
and how many the agent chose, and when it last ran. ↑↓ and Enter or a press show the skill's SKILL.md in the code column, rendered as
markdown, and put what
calls the skill in the composer (`/name ` for Claude Code, a sentence to finish for an agent whose
skills are asked for in words), the focus staying there for the arguments; `v` goes to the file;
Enter on a run shows the call that loaded the skill. Each skill Claude Code calls by
a slash is a command of widecode too, so typing `/` in the composer completes it with its
description. `/skills` shows the tab. The code
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
messages. Under the tools column, what Claude is doing and for how
long (✻ while it thinks), the calls by kind (read, write, run, agents), and the thinking tokens. Under the code column, the
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
`/reload` does. `PLUGINS.md` has the API and how to write one, and `widecode.d.ts`
types it.

The conversation talks to an agent a plugin brings, Claude Code's by default (`plugins/claude/index.ts`,
its CLI over stream-json); config.json's `"agent"` or `--agent <id>` picks another. The `acp` plugin brings the agents that speak ACP, the Agent
Client Protocol, opencode among its defaults (`opencode acp`); another one is an entry in its
section with the command that starts it (`"gemini": {"command": ["gemini", "--experimental-acp"]}`).
Their turns, calls with their diffs, plans, permissions (answered in the request panel), modes and
sessions show as Claude Code's do; titles Claude writes are for Claude Code's sessions only. An ACP
agent's session starts with widecode, so its models and efforts can be chosen before the first
message; a session made and never written to is deleted (the entry's `forget` command) when it is
left. An ACP
agent that takes MCP servers over HTTP gets widecode's own tools (`plugins/ask/index.ts`): `AskUser`
puts its questions in the request panel and `PresentPlan` its plan, which approved in plan mode
switches the agent out of it and asks it to carry the plan out. Claude Code keeps its own tools for
these.

The `pi` plugin brings pi (`@earendil-works/pi-coding-agent`) over its RPC mode (`pi --mode rpc`),
when pi is on PATH: its models and thinking levels as the model and effort, its prompts, steering
and abort, its edits with their diffs, its extensions' dialogs in the request panel and their
notifications, statuses, widgets and editor text on the screen, and its sessions from
`~/.pi/agent/sessions`, resumed with `--session`. widecode's own MCP tools do not reach pi: pi takes
MCP servers only through an extension.

Claude's subagents can run on an ACP target instead: the acp section's `tasks.targets` gives a
`Task` tool (Claude sees `mcp__widecode__Task`) whose `subagent_type` picks an entry, a model and
what it is for, streams the run under the call and answers with its last words. With
`run_in_background` it starts and answers at once; `TaskStop` and `SendMessage` manage it by the id
it returns, and its end comes back as a message to the main agent. A main agent that gives no
tool-use id, such as an ACP agent, gets a card the tool makes itself. `cwd` names the folder it
works in (absolute, or relative to the session's), the session's folder when left out; a boxed
target works only in the session's folder, a folder in `tasks.box.projects` or one inside them.
`isolation: "worktree"` runs it in a git worktree of that folder under `.worktrees/<id>` and
answers with its path (`worktreeSetup` runs only for a worktree of the session's folder); the run's steps are
kept under `.widecode/tasks/<session>/<call>.jsonl` and read back when a resumed session opens the
call. `replaceClaudeSubagents` adds `--disallowedTools Task,Agent,TaskStop,SendMessage` to Claude's
start, so its own subagent tools step aside; `plugins.claude.keepSubagents` keeps them.

widecode keeps a project's sessions in the project, in `.widecode/sessions/<id>.json` (each
session's title, model, cost across CLI processes, thinking tokens, the commit it started on), so
the Sessions tab lists every session of the folder; `.widecode/` holds a `.gitignore` of `*`, so git
leaves it out. Settings live in `~/.widecode` (or `$WIDECODE_HOME`): `config.json`, a `"plugins"`
object with a section per plugin (`false` switches it off; written with every plugin's defaults on
first run) and `"keymap"`, `keys.json` (the user's key bindings over the keymap: by scope, a key to
the action it runs, or null for none; `/help` names the actions and their keys), `state.json` (what
is kept between runs: the code column's wrap, the Files switch, the widths columns were dragged to,
the keymap /keymap chose),
`limits.json` (each agent's last 5-hour and weekly limits, so one agent's are not shown for another) and `logs/`, a file per run (`/log` says
which; the newest 30 kept) with the build, the flags, the sessions and turns, every five minutes
that it is alive, how it ended, and an uncaught error with the trail of what ran last and the screen
as it was, so a crash can be read afterwards (`"log": false` turns it off, `{"dir": "~/x",
"keep": 10}` moves it, `--log <path>` names one file, `--no-log` none); `prompt.md` there is the
user-wide prompt, appended to the agent's before a trusted folder's. The first run moves an
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
command shows every line it prints); `scripts/statusline.sh` is one. F5 cycles the
models plugin's `"list"` (`"agents"` holds another agent's, by its id; its `"effort"` holds the
efforts to start from, `"default"`, by `"providers"` and by `"models"`, under those chosen). Typing `/model` lists the
agent's models above the composer, narrowed by each word typed (`/model dee pro`); ↑↓ choose and
Enter switches. A command's name completes the same way after "/", and `/effort` its levels. The CLI protocol it relies on, measured with recorded fixtures, is in
`PROTOCOL.md`; the manual checklist, driven in a pseudo-terminal, is in
`test/checklist/`.

## The harness: widecode's own agent

`widecode --agent harness` (or `"agent": "harness"` in config.json) talks to widecode's own coding
agent, in the spirit of pi: the same binary started as `widecode --harness`, speaking ACP on stdio
to the acp plugin, calling model APIs directly and running its own tools. It needs an API key, not
a subscription: `widecode --harness-auth deepseek` (or `anthropic`) reads one from stdin into
`~/.widecode/auth.json`, readable by the user alone, and `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY`
in the environment take precedence. `widecode --harness-models` lists the models and which
providers have a key. Anthropic's models, DeepSeek's (through its Anthropic-format endpoint) and
OpenCode Zen's (Claude and Qwen on its Anthropic-format endpoint; DeepSeek, GLM, MiniMax and Kimi
on its OpenAI-compatible one; `widecode --harness-auth opencode`, or `OPENCODE_API_KEY`) are built
in. Zen serves a key the models its account has enabled; `widecode --harness-models` marks the
others.
Another provider is an entry of `harness.providers`, speaking the Anthropic Messages API, or with
`"api": "openai"` an OpenAI-compatible chat completions API (OpenRouter, Groq, a local server):
`"openrouter": {"api": "openai", "baseUrl": "https://openrouter.ai/api/v1", "keyEnv":
"OPENROUTER_API_KEY", "models": [{"id": "qwen/qwen3-coder", "context": 262144}]}`, a model's
`"thinking"` being `toggle` (`thinking: {type}`) or `effort` (`reasoning_effort`).

Its tools are named as Claude Code names them: Read, Write, Edit, Bash, Grep, Glob, LS, Skill,
WebFetch, WebSearch and Task (a subagent: the task run as a session of its own on the same model,
its report the call's result), and widecode's own over its MCP server (AskUser and PresentPlan in the
request panel, the harness folder's tools). It asks no permission: every call runs, as in pi,
but those `permissions.deny` in config.json refuses (the user's and a trusted project's, in Claude
Code's syntax: `Bash(git push *)`, `Read(./.env)`, `Edit(/etc/**)`, `WebFetch(domain:example.com)`,
a tool's name, `mcp__widecode__reload`). Plan
mode (/plan, Shift+Tab) offers the read-only tools alone. Run risky work in a container or a
worktree. Its system prompt holds the project's prompt.md, the instructions in AGENTS.md and
CLAUDE.md from the repository's root down (a trusted folder's) and the skills found in the
folder's `.agents/skills` and `.claude/skills`, the user's `~/.agents/skills` and
`~/.claude/skills`, and `~/.widecode/harness/skills`.

A model that reads images (Anthropic's, Zen's Claude; a configured one with `"vision": true`) gets
the images attached to a message and those Read gives for an image file; another is told they were
left out.

Sessions are JSONL files under `~/.widecode/harness/sessions/`, listed in the Sessions tab, shown
again when opened, named by the provider's cheapest model after the first turn (`/title` asks again
or takes the words after it). Past the context threshold (the window less a reserve, or
`harness.compactAt`, 200,000 tokens by default) the earlier messages are summarized; `/compact
[hint]` does it at once. WebFetch reads a page through headless Chromium (Playwright's, or one on
PATH; curl without one). WebSearch tries SearXNG, Google through the browser, then Brave's and
Tavily's APIs; Google refuses a fresh headless browser on some networks, and SearXNG or a key
avoids that:

```json
{
  "agent": "harness",
  "harness": {
    "model": "deepseek/deepseek-v4-pro",
    "effort": "high",
    "compactAt": 200000,
    "search": { "searxng": "http://127.0.0.1:8080" },
    "browser": { "command": "" }
  }
}
```

A widecode plugin may carry an agent part for the harness's loop: handlers for its events, tools,
commands and settings. The built-in `permission-gate`, `protected-paths`, `inline-bash`,
`claude-rules`, `dirty-repo-guard`, `git-checkpoint`, `todo` and `tools-switch` use it, so a plugin
file changes what the harness does as it changes what widecode shows. `AGENT-PLUGINS.md`
is a short guide to using it; PLUGINS.md's "The agent part" has the API.

The package is `src/harness` (its README has the files).

## Peers: the machines on your network

widecode shares a machine's repositories with the machines paired with it over the LAN, in place and read-only, and the other side fetches. Each machine runs one daemon (`widecode --peers-daemon`, started by the app when the bridge is in use or asked for) that serves git's smart HTTP protocol out of the shared checkouts, announces itself over mDNS (avahi on Linux, dns-sd on macOS) and keeps a registry under `~/.widecode/peers/`: its keypair, the peers it paired with and their tokens, what it shares. Nothing is written into a repository, and a working tree is never touched: a fetch writes refs.

Pairing is a six-digit code: `/peers pair` shows one here for two minutes; `/peers join <host:port> <code>` (or a nearby machine's name) on the other machine exchanges keys and mutual tokens. `/peers share` shares this folder's repository (at its root, every local branch and tag; the registry keeps a branch filter and an allow list per repository), and `/peers share <path>` another checkout of this machine. `/peers host <name>` makes a bare repository under the store that paired peers may push into (`/peers host /path/to/repo.git` hosts one that exists), fetched and pushed at `/h/<name>`; a live checkout is fetched at `/r/<rootCommit>`.

The daemon keeps the machine's shared checkouts fetched from each peer: every two minutes while a peer is online (and when a session asks), it reads what the peer offers, matches each offer to a share here by root commit, sets the peer's copy up as a remote named after the peer in that checkout (its token in the checkout's git config as `http.<url>.extraHeader`, never in a URL), fetches it, and counts the checkout's current branch against the peer's branch of the same name, keeping the commits that are new over there. So the Peers tab speaks for the whole machine, not for the folder a session is in, and the Git tab's `peer` compare base and its Peers section read the same remotes. `/peers clone <peer> <repo> [path]` brings a repository a peer offers that this machine lacks, beside this folder by default, shared here once cloned.

The Peers tab (beside Git) lists this machine with its shares (◆ marks this folder's repository), then each paired peer (● online) with every repository it offers and how this machine's copy stands against it (`↓3` commits to fetch, `↑2` commits they lack, `level`, `not here` when this machine has no copy, `hosted` for a bare repository that takes pushes), the machines nearby not paired yet, and the pairing code while one is shown; the last row says what the keys do for the row under the cursor. Enter opens the row's page in the code column: this machine's id, addresses and the URLs peers use; a peer's address, remote and repositories; a repository's commits to fetch, with the merge or rebase that takes them. `f` fetches from the peer (or the one repository) under the cursor, `c` clones one this machine lacks, `s` shares or unshares this folder, `p` pairs, `x` forgets, `r` reads again. The status bar's `peers` segment says how many peers are online, or which one has commits this machine lacks. Requests from outside the private address ranges are refused; a forgotten peer's token stops working at once. A machine's firewall must let the port in (`sudo ufw allow 7337/tcp` on a Linux box with ufw; macOS asks on the first start when its firewall is on): a peer that cannot be joined or fetched from, while it sees this one, has it closed. The daemon's flags: `--port` (7337 by default), `--name`, `--bind`, `--no-discovery`, `--sync-ms` (120000 by default, 0 leaves the fetching to the sessions' asking); the plugin's section of config.json: `autoFetch`, `refreshMs`.

## Layout

| Directory | What it is |
|---|---|
| `light/packages/native/*`, `light/packages/tui/*` | light's packages: `@lightstart/native` (`light`, the tooling: `prepare`, `build`, `run`, `selftest`, `test`, `coverage`, `typecheck`, `check`, `probes`, `install`, `desktop`), and `lib`, `highlight`, `plugins`, `workspace`, `test`, `kernel`, `ui`, `markdown`: what the core's modules share; the tokenizers; the embedded JavaScript; a folder's files and git; the tests' helpers; the plugin kernel; the palette and the windowed list; Markdown as lines (light's `packages/README.md`) |
| `src/` | the app on `@lightstart/app` (`app.ts` its flags, `modes/`, `controllers/`, `host/`, `compose.ts`, `views/`, `services/`, `runtime/` the plugin runtime, `api/` the plugin API's answers) and its parts, each with its README: `agent` (the `claude -p` sidecar and the MCP server), `conversation` (the conversation with an agent), `harness` (widecode's own agent, `widecode --harness`), `peers` (the LAN git bridge), `screen` (the screen plugins contribute to), `code` (the code column), `chat` (the chat views) |
| `plugins/`, `widecode.d.ts`, `test/`, `box/` | the built-in plugins and their API (`PLUGINS.md`): `plugins/<id>/index.ts` (the built-in plugins: chat, code, tools, agents, files, sessions, git, changes, status, models, languages, and the agents' claude, acp and pi), `widecode.d.ts` (the plugin API's types), `test/` (the tests, fixtures, fakes and goldens; the harness's are `harness-*.test.ts`), `box/` (the sandbox subagents run in) |

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
