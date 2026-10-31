# TODO

Open issues found along the way, each with what is known. The plans (`PLAN.md`, `PLAN-task.md`,
`PLAN-security.md`) hold the larger work.

- A foreground Task run may stop streaming after the user sends a message mid-turn. The message
  closes the model's turn, and `applySubagentEvents` (`packages/conversation/events.ts`) drops a
  foreground run's events once its card's turn is not `model.current`; its permission question is
  also cancelled when that turn closes (`closeTurn` keeps only a background run's). Found while
  fixing the background case (a8078e5); not reproduced yet.
- `apps/widecode/test/acp-dsh.test.ts` fails three checks ("its sessions listed from the agent",
  "resumed without replaying its turns, with a notice", "session/resume for it too, and no replayed
  exchange") in a full parallel `light-native test --node-only`, twice in a row, and passes alone
  and natively: a fixed wait that a loaded machine outruns, as `changes.test.ts` had (dbd309c).
- Alerts ring whether or not the terminal has focus: light's terminal host does not report focus
  (`CSI ?1004h`, then `ESC [ I` and `ESC [ O`). With it, the alerts plugin can alert only when the
  window is in the background.
- The scriptc fork's `FORK.md` shows the `scriptc-dev` wrapper without the
  `SCRIPTC_CACHE_MAX_MB=20480` line the installed wrapper now has (dbd309c explains why).
- The full native run (`pnpm verify`) has not run since the `/subagents` commits (4c020af, ccdbd27)
  and the permission and alerts fixes (a8078e5, 6b908a1).
- The request panel takes every Enter in the composer while it is open (`ChatWidget.submit` in
  `apps/widecode/src/views/chat-widget.ts` hands the text to `panel.submitText`). A message the
  user typed and sent as a background subagent's question opened became its answer "in the
  user's own words"; the acp plugin finds no option in it and answers opencode `cancelled`, a
  reject. The bell rang and the question was gone at once. Text typed before a request opened
  should stay a message; a permission should offer no free-text row, and free text that reaches
  one should not turn into a silent reject.
