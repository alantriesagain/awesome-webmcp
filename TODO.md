# TODO

Open issues found along the way, each with what is known.

- A foreground Task run may stop streaming after the user sends a message mid-turn. The message
  closes the model's turn, and `applySubagentEvents` (`src/conversation/events.ts`) drops a
  foreground run's events once its card's turn is not `model.current`; its permission question is
  also cancelled when that turn closes (`closeTurn` keeps only a background run's). Found while
  fixing the background case (a8078e5); not reproduced yet.
- `test/acp-dsh.test.ts` fails three checks ("its sessions listed from the agent",
  "resumed without replaying its turns, with a notice", "session/resume for it too, and no replayed
  exchange") in a full parallel `light test --node-only`, twice in a row, and passes alone
  and natively: a fixed wait that a loaded machine outruns, as `changes.test.ts` had (dbd309c).
- Alerts ring whether or not the terminal has focus: light's terminal host does not report focus
  (`CSI ?1004h`, then `ESC [ I` and `ESC [ O`). With it, the alerts plugin can alert only when the
  window is in the background.
- The full native run (`pnpm verify`) has not run since the `/subagents` commits (4c020af, ccdbd27)
  and the permission and alerts fixes (a8078e5, 6b908a1).
- Reloading every plugin from the harness's `reload` tool fails the call that asked for it:
  `JsRuntime`'s full reload runs `mcp.failAll("widecode's plugins reloaded; call the tool again")`
  (`src/runtime/runtime.ts`), and the reload is one of the calls in flight. The
  agent sees its own reload interrupted. The calling `reload` should be answered once the plugins
  are back.
- A malformed key in the box's credentials file refuses the whole box (`box.mjs`), so a bad Claude
  token also stops opencode subagents. A bad key could be left out with a warning naming it, the
  box starting with the keys that are valid.
- The orchestration benchmark's next round (`src/harness/bench/NOTES.md`): every task with repeats,
  Claude Code against the harness on Opus. Claude Code's cost on the subscription is unknown in
  its records; compute it from its tokens with the harness's price table. A run waiting on a
  question should end at once as such, not wait out its time.
- The harness as an orchestrator still lacks: a notice when a file it read changes on disk (a
  subagent's edit, then a Write from memory, loses the subagent's work), stdio MCP servers (HTTP
  only today), a model or a read-only kind for its own Task, timed wake-ups, and PDF reading.
- The single benchmark's `--user-store` aside, a clean run makes an empty HOME under /tmp
  (`harness-bench-home-*`) when the user has skills, and some are left behind after the run.
