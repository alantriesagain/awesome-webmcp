# The benchmarks: results and lessons

What the runs of November 2026 found, how the machine is set up for them, and what went wrong on
the way. How to run them is in `src/harness/README.md` ("The benchmark", "The orchestration
benchmark"); open work is in `TODO.md`. Records and transcripts go to `bench/results/` and
`bench/orchestrate/results/`, both ignored by git.

## The aim

The harness should do as well as opencode and pi on the same model, and as well as Claude Code as
an orchestrator, on any combination of models: the user's own setup is Opus leading in Claude Code
with DeepSeek V4.1 Flash subagents. Quality comes before cost: when the two pull apart, the harness
takes the better answer (WebFetch reads a long page through the model, though it costs more on
DeepSeek, where a page kept in the cached conversation is cheaper).

## The setup on this machine

- Keys: `~/.widecode/auth.json` holds `deepseek` and `opencode` (OpenCode Zen, pay as you go). The
  session's own subagents run on `opencode-go/deepseek-v4.1-flash`, OpenCode Go, a separate plan.
  Zen has no balance API: its console at opencode.ai shows the credit.
- pi 1.5.2 is installed with npm (`~/.nvm/versions/node/v25.3.0/bin/pi`). `~/.pi/agent/auth.json`
  gives it Zen through a key command that reads the harness's key, so no copy is kept. A benchmark
  run gives pi an empty agent folder of its own, with the same command and Exa's MCP server.
- Web search for every agent is Exa's hosted MCP server (`https://mcp.exa.ai/mcp`, no key): the
  harness's WebSearch backend, opencode's websearch once `OPENCODE_ENABLE_EXA=1`, pi through an
  `mcp.json`.
- Claude Code as an orchestrator runs on the user's login and subscription; its runs count against
  the plan's limits, so they run in small rounds when the user asks.

## Single agents on DeepSeek V4.1 Flash

Twenty tasks, five runs each, the agents interleaved (300 runs, about $1.40):

| | passed | requests | cost |
|---|---|---|---|
| harness | 99/100 | 6.2 | $0.425 |
| pi 1.5.2 | 98/100 | 5.1 | $0.432 |
| opencode 1.19.5 | 97/100 | 5.2 | $0.549 |

The tasks no longer separate the agents on quality: nearly every run passes, so they measure
efficiency. The harness's remaining gap is about one request more per task. What closed the rest:

- The harness ran on the user's store, so their Claude skills sat in every request: the first
  request was 4,100 tokens against pi's 1,600. The benchmark now runs it on a clean store.
- Edit refused a file the model had seen through `cat`; an exact match found once now goes through.
- Read padded line numbers and returned a whole file; on the long-file task the peak context went
  from 17,700 tokens to 9,800 once a Read without a limit stopped at 16 KB.
- WebSearch cut Exa's passages to 300 characters, so the model fetched the pages; requests on the
  web tasks went from 4.4 to 5.2 down to 3.6 once a hit kept 2,000 characters.
- WebFetch ignored its prompt and returned 50,000 characters, so a big JSON page lost its answer
  past the cut and the context reached 111,000 tokens; the model now reads a long page and answers
  the prompt. On the four web tasks, five runs each: the harness, opencode and pi all passed
  20/20, the harness's largest context 18,000 tokens, its cost $0.172 against $0.121 and $0.128.

## Orchestrators

The harness as widecode's main agent, delegating through widecode's Task to DeepSeek Flash on
OpenCode Go. On DeepSeek V4 Pro it passed every part (9/9) but delegated only the four-part task,
doing the two- and three-part ones itself despite the guidance. On Opus 5.5, one run each:

| task | orchestrator | parts | requests | cost at Zen's Opus price |
|---|---|---|---|---|
| easy-two | Claude Code | 2/2 | 6 | $0.22 |
| easy-two | harness | 2/2 | 7 | $0.12 |
| medium-three | Claude Code | 3/3 | 9 | $0.29 |
| medium-three | harness | 3/3 | 11 | $0.20 |

Both delegated every part in the background and edited nothing themselves; the harness cost 30 to
45% less, from a smaller system prompt and tool list. Two tasks of one run each is a small sample:
the three- to four-part and web tasks, with repeats, are the next round.

## What went wrong, so it does not again

- The orchestration runner first started widecode without `WIDECODE_HOME`, on the user's store: it
  rewrote `~/.widecode/state.json` once (columns, chosen models). It now passes the run's store and
  stops when the app names another.
- Claude Code's first runs waited twenty minutes on a permission question nobody answers; each
  run's store now starts in the "full" approval mode, the same for every orchestrator.
- Claude Code's transcript repeats a message's usage on every content block; the reader counts a
  request once by its message id.
- The harness's turn answer counted only its main loop's tokens, so a page read or a subagent was
  missing from the computed cost; the answer now adds the side requests'.
- A task can have several right answers: three Node.js releases came out on the day the two-step
  web question first asked for, and every agent fetched page after page to choose. Check a task's
  answer against its source for uniqueness, not only for truth.
- Agents take shortcuts a check cannot see: all three curled npm's registry on the questions that
  said "not npm". The detectors flag it (`package-manager-on-web`).
- Under node, the harness daemon fails on a real store with plugins (`wcjsNew is not defined`): the
  QuickJS stand-in is not loaded there. The benchmark's clean store avoids it; a script driving the
  daemon from source needs `--harness-home` on a temp store too.
- A background command in Claude Code's tool times out at ten minutes; long runs went detached
  (`setsid nohup`) with a file marking their end, watched with Monitor.
