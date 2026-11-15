// ffi: @light/plugins/native/ffi.json
// Messages queued while the agent works, and side questions. Through the fake ACP agent
// (test/fake-acp.mjs, as opencode): ↑ in an empty composer takes a queued message
// back into it before the agent's call ends, the chat saying how; one left queued goes into the turn
// once the call ends (the agent's next step reads it), the turn ending once both prompts are
// answered; /btw asks in a fork of the session, in plan mode, its answer in the chat as an aside
// and the fork deleted after, while a turn runs too. An agent that cannot fork says so. Through the
// fake Claude CLI (test/fake-claude.mjs): a queued message taken back with
// cancel_async_message, and /btw as Claude Code's side question, the earlier ones its history.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { Item, PROMPT, TEXT, Turn } from "../src/conversation/model.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode, createWidecode, Widecode } from "../src/compose.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

/** The chat's lines at 80 cells. */
const chat = (w: Widecode): string[] => {
  const s = w.chat.pane.source;
  s.prepare(80);
  const out: string[] = [];
  for (let i = 0; i < s.count(); i++) out.push(s.line(i, 80).runs.map((r: Run) => r.text).join("").replace(/\s+$/, ""));
  return out;
};

const said = (t: Turn): string => t.body.children.filter((i: Item) => i.kind === TEXT).map((i: Item) => i.text).join(" ");
const up = (w: Widecode): void => {
  w.host.screen.focus("chat");
  w.shell.handleKey(new KeyEvent("up", "", false, false, false));
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-queue-"));
  const fake = join(process.cwd(), "test/fake-acp.mjs");
  const forgotten = join(folder, "forgotten.txt");
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  w.host.session.agentId.value = "fake";
  const config: unknown = {
    acp: {
      agents: {
        fake: { name: "Fake", command: ["node", fake], forget: ["node", fake, "--forget", "{session}", "--forgotten", forgotten], midTurn: true },
        old: { name: "Old", command: ["node", fake, "--legacy"] },
      },
    },
  };
  w.start(config, new NoStateFile(), []);
  await w.host.load();
  const idle = (): boolean => !c.model.running && c.model.pending.length === 0;
  const last = (): Turn => c.model.turns[c.model.turns.length - 1];
  const input = w.chat.pane.input;
  const said_ = (): string => w.host.screen.message.peek();

  // Taken back before the call ends.
  w.host.roles.chat.submit("work");
  await until(() => c.model.running);
  w.host.roles.chat.submit("first extra");
  ok("queued while the call runs, and the chat says ↑ takes it back", c.model.pending.length === 1 && chat(w).some((l: string) => l.includes("⧗ queued: first extra")) && chat(w).some((l: string) => l.includes("↑ in an empty composer takes it back to edit")));
  up(w);
  ok("↑ in the empty composer: back in it, off the queue", (await until(() => input.value() === "first extra")) && c.model.pending.length === 0);
  ok("and the turn goes on without it", (await until(idle)) && said(last()) === "Worked.");

  // Left queued: into the turn once the call ends.
  input.lines = [""];
  const turns = c.model.turns.length;
  w.host.roles.chat.submit("work");
  await until(() => c.model.running);
  w.host.roles.chat.submit("also this");
  ok("into the turn once the call ended, the agent's reply taking it in", (await until(idle)) && said(last()) === "Worked. Also: also this");
  eq("one turn, the message in it after the call", String(c.model.turns.length - turns) + " " + last().body.children.map((i: Item) => (i.kind === PROMPT ? "prompt:" + i.text : i.kind === TEXT ? "text" : "tool")).join(","), "1 tool,prompt:also this,text");

  // /btw: a fork of the session, in plan mode, then deleted.
  w.host.roles.chat.submit("/btw what was that?");
  ok("a side question: asked at once, answered in the chat apart from the conversation", await until(() => chat(w).includes("btw what was that?") && chat(w).includes("  │ Side answer to: what was that? (in plan)")));
  ok("its fork deleted after", await until(() => existsSync(forgotten) && readFileSync(forgotten, "utf8") === "fork-1\n"));
  const turnsNow = c.model.turns.length;
  w.host.roles.chat.submit("work");
  await until(() => c.model.running);
  w.host.roles.chat.submit("/btw and now?");
  ok("while a turn runs too", (await until(() => chat(w).includes("  │ Side answer to: and now? (in plan)"))) && c.model.running);
  ok("the turn not touched by it", (await until(idle)) && said(last()) === "Worked." && c.model.turns.length === turnsNow + 1);
  w.host.roles.chat.submit("/btw");
  eq("/btw alone says what it does", said_(), "/btw <question>: Fake answers it apart from the conversation, while it works too");
  eq("an agent that cannot fork", w.host.session.useAgent("old"), "");
  c.reset();
  w.host.roles.chat.submit("hello");
  await until(idle);
  w.host.roles.chat.submit("/btw anything?");
  eq("says so", said_(), "Old cannot fork a session for a side question");
  w.host.kernel.stop();
  w.js.killProcesses();

  // Claude Code: cancel_async_message and side_question.
  const cc = new Conversation(ws.folder);
  cc.executable = join(process.cwd(), "test/fake-claude.mjs");
  cc.extraArgs.push("--fixture", join(process.cwd(), "test/fixtures/turn.ndjson"));
  const wc = createWidecode(ws, cc, null);
  wc.host.roles.chat.submit("Reply with exactly the word PONG and nothing else.");
  ok("Claude's turn", await until(() => cc.model.turns.length === 1 && cc.model.turns[0].result !== null));
  wc.host.roles.chat.submit("a second thought");
  ok("a message the CLI holds in its queue", cc.model.pending.length === 1);
  up(wc);
  ok("↑: dropped from the CLI's queue, back in the composer", (await until(() => wc.chat.pane.input.value() === "a second thought")) && cc.model.pending.length === 0);
  wc.chat.pane.input.lines = [""];
  wc.host.roles.chat.submit("/btw what did I ask?");
  ok("/btw: Claude Code's side question, answered in the chat", await until(() => chat(wc).includes("btw what did I ask?") && chat(wc).includes("  │ Side answer to: what did I ask?")));
  wc.host.roles.chat.submit("/btw and before that?");
  ok("the earlier side questions are its history", await until(() => chat(wc).includes("  │ Side answer to: and before that? (after 1)")));
  ok("none of it in the conversation", cc.model.turns.length === 1 && cc.model.pending.length === 0);
  cc.kill();
  wc.host.kernel.stop();
  wc.js.killProcesses();

  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
