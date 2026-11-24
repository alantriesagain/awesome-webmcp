# TODO

Open issues found along the way, each with what is known.

- A foreground Task run may stop streaming after the user sends a message mid-turn. The message
  closes the model's turn, and `applySubagentEvents` (`src/conversation/events.ts`) drops a
  foreground run's events once its card's turn is not `model.current`; its permission question is
  also cancelled when that turn closes (`closeTurn` keeps only a background run's). Found while
  fixing the background case (a8078e5); not reproduced yet.
- `test/acp-dsh.test.ts` was seen failing three checks ("its sessions listed from the agent",
  "resumed without replaying its turns, with a notice", "session/resume for it too, and no replayed
  exchange") in a full parallel `light test --node-only`, twice in a row, passing alone and
  natively. Not reproduced since in six parallel runs, and the checks already poll with a 15 s
  timeout rather than a fixed wait, so the original "fixed wait like `changes.test.ts` had"
  diagnosis no longer matches the file. Leave open in case it recurs, but the cause needs a fresh
  look if it does.
- Alerts ring whether or not the terminal has focus: light's terminal host does not report focus
  (`CSI ?1004h`, then `ESC [ I` and `ESC [ O`). With it, the alerts plugin can alert only when the
  window is in the background.
- Reloading every plugin from the harness's `reload` tool fails the call that asked for it:
  `JsRuntime`'s full reload runs `mcp.failAll("widecode's plugins reloaded; call the tool again")`
  (`src/runtime/runtime.ts`), and the reload is one of the calls in flight. The
  agent sees its own reload interrupted. The calling `reload` should be answered once the plugins
  are back.
- A malformed key in the box's credentials file refuses the whole box (`box.mjs`), so a bad Claude
  token also stops opencode subagents. A bad key could be left out with a warning naming it, the
  box starting with the keys that are valid.
- The orchestration benchmark's next round (`src/harness/bench/NOTES.md`): Claude Code's cost on
  the subscription is now computed from its tokens with the harness's price table, and a run
  waiting on a question is sidestepped by forcing full-approval mode rather than made to end at
  once. The round itself, every task with repeats, Claude Code against the harness on Opus, has
  not run: `orchestrate/results/second.jsonl` holds only `medium-three` and `mixed-four` on
  `opencode/deepseek-v4-pro`, repeat 1.
- The harness as an orchestrator still lacks: a notice when a file it read changes on disk (a
  subagent's edit, then a Write from memory, loses the subagent's work), stdio MCP servers (HTTP
  only today), a model or a read-only kind for its own Task, timed wake-ups, and PDF reading.
- The app-layer redesign's last open item (REDESIGN.md, since removed as done otherwise): one
  settings merge for plugins, columns, permissions, keymap, agent and log. Today `mergePlugins`
  (also used for columns) and `mergePermissions` (`src/services/harness.ts`) are separate merge
  policies, and keymap, agent and log read only from the user's `config.json`, with no project
  merge at all.
- On macOS, `test/trust-run.test.ts` passes every check and prints its tally, then never exits
  under node (seen for 30 minutes on the Mac, with no child process left): something the run
  opened keeps the event loop alive there, likely a watcher, though the test stops the plugin
  watcher and closes the workspace. It exits at once on Linux. light test's timeout now ends it as a
  timed-out FAIL; the cause is not found yet.
- `test/plugins.test.ts`'s "every built-in plugin answers its defaults" flakes on whether the
  `skills` plugin's default carries a `*` (its value is not plain `true`): seen passing and failing
  across two otherwise identical node-only runs with no change to that plugin in between. Not
  investigated; likely a timing read of the folder's `skills/` directory in `defaults()`.
