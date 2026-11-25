# Agents and plugins: a short guide

lightcode can drive three agents: Claude Code, its own harness, and pi. Plugins change what
lightcode shows, and with the harness they can also change what the agent does: stop a command,
add a tool, rewrite a prompt. This guide covers how to use that and how to write your own.

## Pick an agent

| Agent | How to choose it | Needs |
|---|---|---|
| Claude Code | the default | `claude` installed |
| The harness | `lightcode --agent harness`, or `"agent": "harness"` in config.json | an API key: `lightcode --harness-auth deepseek` (or `anthropic`, `opencode`) |
| pi | `lightcode --agent pi`, or `"agent": "pi"` | `pi` on your PATH (`npm i -g @earendil-works/pi-coding-agent`) |

config.json is `~/.lightcode/config.json`, and a trusted project's `.lightcode/config.json` goes
over it.

With pi, pi runs its own extensions. Their questions open in lightcode's request panel, and their
status lines and widgets show at the bottom of the screen.

## What the built-in plugins do

These work when the harness is the agent. They are on by default.

| Plugin | What it does | Commands |
|---|---|---|
| `permission-gate` | asks before a risky shell command (`rm -rf`, `sudo`, `git push --force`, `git reset --hard`, ...) | |
| `protected-paths` | refuses writes to `.env`, `.git/` and `node_modules/` | |
| `git-checkpoint` | saves the working tree at the start of each turn, so you can go back | `/checkpoints`, `/checkpoint restore <n>`, `/checkpoint clear` |
| `dirty-repo-guard` | asks before forking a session while the repository has uncommitted changes | |
| `todo` | gives the agent a todo list it keeps across the session | `/todos` |
| `tools-switch` | turns the agent's tools on and off | `/tools`, `/tools off <name>`, `/tools on <name>`, `/tools reset` |
| `inline-bash` | runs `!{command}` in your message and puts its output there before the agent reads it | |
| `claude-rules` | adds the project's `.claude/rules/*.md` to the agent's instructions | |

`/reload` reloads every plugin without restarting the session.

Checkpoints are commits that only the session knows about. They add nothing to your branches or
your stash, and git deletes old ones on its own after about two weeks.

## Turn a plugin off or change it

```json
{
  "plugins": {
    "inline-bash": false,
    "permission-gate": { "patterns": ["rm -rf", "git push --force", "terraform apply"] },
    "protected-paths": { "paths": [".env", ".git/", "secrets/", "**/*.pem"] }
  }
}
```

`false` turns a plugin off. An object holds its settings.

## Skills and prompt templates

The harness reads the same skills and prompt templates as Claude Code and pi.

- A skill is a folder with a `SKILL.md`. Put it in the project's `.agents/skills/`,
  `.claude/skills/` or `.pi/skills/`, or in your `~/.agents/skills/`, `~/.claude/skills/` or
  `~/.pi/agent/skills/`.
- A prompt template is a Markdown file. `review.md` becomes the command `/review`. Put it in the
  project's `.lightcode/prompts/` or `.pi/prompts/`, or in your `~/.lightcode/harness/prompts/` or
  `~/.pi/agent/prompts/`. In the text, `$1` is the first
  word after the command, `$@` all of them, and `${1:-main}` the first word or `main`.

```markdown
---
description: Review a file
argument-hint: <path>
---
Review $1 for bugs and unclear names.
```

A project's files are used only after you trust the folder (lightcode asks the first time, or
`/trust`).

## Write your own plugin

A plugin is a `.js` file in `~/.lightcode/plugins/` (yours, everywhere) or in a project's
`.lightcode/plugins/` (that project only). lightcode loads it when you save it.

A plugin has two parts, and either can be left out:

- `activate(api)` runs in lightcode: keys, tabs, status bar.
- `agent(agent)` runs inside the harness and works on the agent's turn.

This one asks before any force push:

```js
lightcode.plugin({
  id: "no-force-push",
  agent(agent) {
    agent.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "Bash") return;
      const command = String(event.input.command);
      if (!command.includes("git push --force")) return;
      const yes = await ctx.ui.confirm("Force push?", command);
      if (!yes) return { block: true, reason: "the user said no" };
    });
  },
});
```

Give the agent a tool, or yourself a command:

```js
lightcode.plugin({
  id: "words",
  agent(agent) {
    agent.registerTool({
      name: "word_count",
      description: "Count the words in a text.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: async (id, params) => ({ content: [{ type: "text", text: String(params.text.split(/\s+/).filter(Boolean).length) }] }),
    });
    agent.registerCommand("hello", { description: "Say hello", handler: (args, ctx) => ctx.ui.notify("Hello " + args) });
  },
});
```

A plugin can also be a folder, `plugins/<name>/index.js`, with its own `skills/` and `prompts/`
beside it. The harness offers those too.

In `tool_call` and `tool_result`, the harness's tools have the names the model sees: `Bash` (its
input has `command`), `Read`, `Write` and `Edit` (with `file_path`), `Grep`, `Glob` and `LS`.

The full list of events and calls is in [PLUGINS.md](PLUGINS.md), "The agent part". The built-in
plugins in `plugins/<id>/index.ts` are short examples to copy from.

## Limits

- The `agent` part runs only when the harness is the agent. With Claude Code or pi it is skipped.
- The two parts of a plugin run in different processes. They talk with `agent.app.send` and
  `api.agentPart.on` (and back), not through shared variables.
- pi's own extensions do not load in the harness, because they need Node. To use them, run pi as
  the agent.
- A plugin call has 250 ms of CPU time. A plugin that runs longer is turned off until you save it
  again.
