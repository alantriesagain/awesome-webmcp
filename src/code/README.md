# src/code

The code column of an agent's terminal, in the palette's colors (`@lightstart/tui`). `diff.ts` loads a `CodeFile`: the file as it is with its changes against a base in place (git's whole-file diff parsed, tabs expanded, a cap on size), or as a commit left it. `code-view.ts` is `CodePane`, the view drawing it with a gutter, the change bands, n and p between changes, wrap, and a plugin's own rows in its place. `agent-source.ts` and `call-source.ts` draw a subagent's steps and one tool call's page from the conversation's model (through `src/conversation`'s `ModelSource`, on a `ConversationHolder`). `target.ts` is `CodeTarget`, the role other plugins reach the column through (open a file, a commit's change, a call, a subagent, a view); the plugin playing the column subclasses it.

Tests: `test/code-diff.test.ts`; the view is proven by lightcode's screen and goldens tests.
