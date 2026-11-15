# The manual checklist, driven

Each script runs dist/widecode in a pseudo-terminal through `../drive.py` (keys, text, mouse presses,
screens read back with F12) and prints what it saw; screens and logs go to `$CHECKLIST_OUT`
(default /tmp/code-checklist/). The live ones talk to Claude (haiku, low effort, nothing saved).
Run from this directory, after `light build` has a fresh `dist/widecode`:

| Script | Checks |
|---|---|
| c1.py | resume the newest bootstrapp session (view only): time to paint, PgUp/wheel frame times, load earlier |
| c2.py | resume a session another Claude is running: the "another Claude" warning |
| c3.py, c3b.py | AskUserQuestion with two questions (multi-select, own words); an interrupt withdraws an open question |
| c4.py | plan mode: decline a plan with feedback, approve the revision, the change made, bypass again |
| c5.py | /model and /effort mid-session (same session, the next turn on the new model) |
| c6.py | @ completion, an image attached by @path, a text file by @path |
| c8.py | Esc during a 30 s Bash call; two parallel subagents, a card opened by a press |
| c10.py | the code column follows Claude's edit; a commit outside the app clears the markers |
| c11.py | a folder outside git; /open idle and while Claude works; quitting mid-turn |
| c13.py | the CLI's processes while a turn runs and after quitting |
