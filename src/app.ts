// widecode's app config: the name, the terminal host, the flags the interface takes and its stores.
// The host parses the flags strictly before any controller starts, and a controller reads them
// from `app.args`. The session records still open their own JSONL store per folder, so the app's
// `main` store is memory.
import { defineApp } from "@lightstart/app";

export default defineApp({
  name: "widecode",
  host: "tui",
  root: "app-root",
  args: {
    dir: { description: "The folder (default: where it was launched)" },
    agent: { description: "The agent to talk to: claude (default, Claude Code), or one a plugin brings" },
    claude: { description: "The CLI (default: `claude` on PATH, then ~/.local/bin/claude)" },
    model: { description: "The model for new sessions (default: the models plugin's first, opus[1m])" },
    effort: { description: "The effort level" },
    resume: { description: "Open a session of this folder" },
    open: { description: "A file to show at start, relative to the folder" },
    log: { description: "The log's file (default: one of this run's own in ~/.widecode/logs, as config.json's \"log\" says)" },
    "no-log": { flag: true, description: "Log to no file (stdout is the screen)" },
    selftest: { description: "A scripted check (selftest.ts)" },
    "fake-fixture": { description: "The fixture the fake CLI replays" },
    ephemeral: { flag: true, description: "Sessions are not saved (--no-session-persistence)" },
    trust: { flag: true, description: "Trust the folder for this run" },
  },
  stores: { main: { kind: "memory" } },
});
