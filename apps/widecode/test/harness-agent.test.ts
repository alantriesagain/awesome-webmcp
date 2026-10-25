// ffi: @light/plugins/native/ffi.json
// widecode's own agent, the harness (packages/harness), as the acp plugin drives it under node
// (`node packages/harness/main.ts --harness`, the entry's command in the config, as the real one
// is the binary with `--harness`): its session starts with widecode, with its model, effort and
// mode as config options; the project's prompt and trust reach it in `_meta.widecode` with the
// session and each prompt (the daemon's trace says so); a reply from the fake model's fixture
// streams into the chat with its thinking; a message sent meanwhile steers the turn and is
// answered with it; Esc cancels a held turn; a model error is a notice; /new starts another
// session; the tools command answers the Available tab; the chosen harness shows as the agent; the
// Sessions tab lists the first session with the title the fake model gave, opening it again shows
// its turns from its file, /title names it, a side question runs in a fork forgotten after.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { Item, TEXT, THINKING, TOOL, Turn } from "@widecode/conversation/model.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { Run } from "@bootstrapp/light/native/tui/lines.ts";
import { KeyEvent } from "@bootstrapp/light/native/tui";
import { done, eq, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

const kinds = (items: Item[]): string => items.map((i: Item) => (i.kind === THINKING ? "thinking" : i.kind === TEXT ? "text:" + i.text : "other")).join(",");

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-harness-"));
  const home = mkdtempSync(join(tmpdir(), "widecode-harness-home-"));
  writeFileSync(join(folder, "a.txt"), "one\n");
  const fixture = join(home, "model.jsonl");
  writeFileSync(
    fixture,
    [
      '{"match":"hello","text":"Hello, world.","thinking":"Thinking about it.","input":12,"output":4}',
      '{"match":"slow","text":"Working on it for a while now.","chunks":4,"delayMs":60}',
      '{"match":"run","text":"Listing.","tools":[{"name":"Bash","input":{"command":"ls -1","description":"List files"}},{"name":"Read","input":{"file_path":"a.txt"}}]}',
      '{"match":"result","text":"One file, one line."}',
      '{"match":"edit","text":"Editing.","tools":[{"name":"Edit","input":{"file_path":"a.txt","old_string":"one","new_string":"one\\ntwo"}}]}',
      '{"match":"result","text":"Edited."}',
      '{"match":"hold","text":"Holding","hold":true}',
      '{"match":"fail","error":"model unavailable"}',
    ].join("\n") + "\n",
  );
  const log = join(home, "trace.log");
  const main = join(process.cwd(), "..", "..", "packages", "harness", "main.ts");
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  w.host.session.agentId.value = "harness";
  const config: unknown = {
    acp: {
      agents: {
        harness: {
          name: "harness",
          command: ["node", main, "--harness", "--harness-home", home, "--log", log, "--harness-fake", fixture],
          tools: ["node", main, "--harness-tools", "{mode}"],
          sessions: ["node", main, "--harness-sessions", "--harness-home", home],
          forget: ["node", main, "--harness-forget", "{session}", "--harness-home", home],
          midTurn: true,
          own: true,
        },
      },
    },
  };
  w.start(config, new NoStateFile(), []);
  w.host.session.setTrusted(true);
  c.prepare();
  await w.host.load();
  const idle = (): boolean => !c.model.running && c.model.pending.length === 0;
  const last = (): Turn => c.model.turns[c.model.turns.length - 1];
  const sent = (): string => readFileSync(log, "utf8");
  const turn = async (text: string): Promise<boolean> => {
    const before = c.model.turns.length;
    w.host.roles.chat.submit(text);
    return until(() => c.model.turns.length > before && idle());
  };

  ok("the session starts with widecode: its model and effort", await until(() => c.info.modelId === "fake/fake" && c.model.effort === "high"));
  eq("the modes it offers", c.agent.choices().modes.map((m) => m.value).join(","), "build,plan");
  eq("the agent's name", c.agent.name(), "harness");
  ok("the session was made with the project's prompt and trust in _meta", sent().includes('"method":"session/new"') && sent().includes('"_meta":{"widecode":{"systemPrompt":"You are running inside widecode') && sent().includes('"trusted":true'));

  ok("a reply from the fixture", await turn("hello there"));
  eq("its thinking, then its text", kinds(last().body.children), "thinking,text:Hello, world.");
  ok("the prompt carried _meta too", sent().includes('"method":"session/prompt"') && sent().split('"_meta":{"widecode"').length > 2);
  ok("the usage reached the status", c.info.contextInput + c.info.contextOutput > 0 || c.model.model.length > 0);

  // A message sent mid-turn steers the turn and is answered with it.
  const before = c.model.turns.length;
  w.host.roles.chat.submit("slow please");
  await until(() => c.model.turns.length > before && last().body.children.some((i: Item) => i.kind === TEXT));
  w.host.roles.chat.submit("and also this");
  ok("both answered at the turn's end", await until(() => idle() && c.model.pending.length === 0));
  const texts: string[] = [];
  for (const t of c.model.turns.slice(before)) for (const i of t.body.children) if (i.kind === TEXT) texts.push(i.text);
  eq("the reply, then the steered message's", texts.join(" | "), "Working on it for a while now. | You said: and also this");

  // A reply calling tools: the calls in the Tools tab with their output, counted in the Available tab.
  ok("a turn with tool calls", await turn("run it"));
  const calls = last().body.children.filter((i: Item) => i.kind === TOOL);
  eq("the calls, their tool and line, their results", calls.map((i: Item) => i.name + " " + i.summary + " → " + (i.result !== null ? i.result.text.replace(/\n/g, "|") : "?")).join(" ; "), "Run ls -1 → a.txt ; Read a.txt →      1\tone");
  eq("what the tools counted as: the tool's name, the first title", calls.map((i: Item) => i.tool).join(","), "Bash,Read");
  eq("the text after the results", last().body.children.filter((i: Item) => i.kind === TEXT).map((i: Item) => i.text).join("|"), "Listing.|One file, one line.");

  // An edit: its diff over the whole file with the lines' numbers, followed by the code column.
  ok("a turn with an edit", await turn("edit it"));
  const edit = last().body.children.find((i: Item) => i.kind === TOOL) ?? null;
  const hunks = edit === null || edit.result === null ? "" : edit.result.patch.map((h) => String(h.oldStart) + "," + String(h.newStart) + ":" + h.lines.join("|")).join(" ");
  eq("its file, its line, its diff with the file's line numbers", (edit === null ? "" : edit.category + " " + edit.paths.join(",") + " " + edit.summary) + " " + hunks, "edit " + join(folder, "a.txt") + " a.txt 1,1: one|+two");
  eq("the code column follows it", c.model.lastEdit, join(folder, "a.txt"));
  eq("the file changed", readFileSync(join(folder, "a.txt"), "utf8"), "one\ntwo\n");

  const held = c.model.turns.length;
  w.host.roles.chat.submit("hold on");
  await until(() => c.model.turns.length > held && last().body.children.some((i: Item) => i.kind === TEXT));
  c.interrupt();
  ok("Esc cancels the held turn", await until(() => idle()));
  ok("said as interrupted", last().body.children.some((i: Item) => i.text.startsWith("Interrupted")) || last().after.children.some((i: Item) => i.text.startsWith("Interrupted")));

  ok("a model error ends the turn with a notice carrying the message", (await turn("fail now")) && last().body.children.some((i: Item) => i.text === "Error" && i.detail.includes("model unavailable")));

  const chat = (): string[] => {
    const s = w.chat.pane.source;
    s.prepare(80);
    const out: string[] = [];
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 80).runs.map((r: Run) => r.text).join("").replace(/\s+$/, ""));
    return out;
  };
  ok("the chat shows the reply", chat().some((l) => l.includes("Hello, world.")));

  const available = (): string => {
    const p = w.host.screen.findPanel("available");
    if (p === null) return "none";
    const s = p.view.source;
    s.prepare(40);
    const out: string[] = [];
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 40).runs.map((r: Run) => r.text).join("").trim().replace(/(\S) {2,}(\S)/g, "$1  $2"));
    return out.join("|");
  };
  await until(() => available().startsWith("harness|Read  ×1|Write|Edit  ×1|Bash  ×1"));
  eq("the tools command answers the Available tab, with the calls counted", available().split("|").slice(0, 8).join("|"), "harness|Read  ×1|Write|Edit  ×1|Bash  ×1|Grep|Glob|LS");
  eq("plan mode", c.setMode("plan"), "");
  await until(() => available().startsWith("harness|Read  ×1|Grep"));
  eq("plan mode offers the read-only tools", available().split("|").slice(0, 6).join("|"), "harness|Read  ×1|Grep|Glob|LS|widecode  MCP");

  const sessions = sent().split('"method":"session/new"').length - 1;
  const firstSession = c.sessionId;
  c.reset();
  c.prepare();
  ok("/new starts another session on the same process", await until(() => sent().split('"method":"session/new"').length - 1 > sessions && c.model.effort === "high"));

  // The sessions: the first one in the Sessions tab with the title the fake model gave, opened again with its turns shown; /title; a fork for a side question, forgotten after.
  const sessionRows = (): string[] => {
    const p = w.host.screen.findPanel("sessions");
    const out: string[] = [];
    if (p === null) return out;
    const s = p.view.source;
    s.prepare(60);
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 60).runs.map((r: Run) => r.text).join("").trim());
    return out;
  };
  w.host.screen.showPanel("sessions");
  ok("the first session in the Sessions tab, named by the fake model, from session/list", await until(() => sessionRows().some((l) => l.includes("Fake session title"))));
  const p = w.host.screen.findPanel("sessions");
  const row = sessionRows().findIndex((l) => l.includes("Fake session title"));
  if (p !== null && row >= 0) p.press(row, 0);
  const open = w.host.kernel.actions.find("sessions.resume");
  if (open !== null) open.onRun(new KeyEvent("enter", "", false, false, false), 1);
  ok("opened again: the same session, its turns shown from the file (session/load)", await until(() => c.sessionId === firstSession && c.model.turns.length >= 5 && chat().some((l) => l.includes("Hello, world.")) && sent().includes('"method":"session/load"')));
  const files = (): string[] => readdirSync(join(home, "harness", "sessions", folder.replace(/[^A-Za-z0-9]/g, "-"))).sort();
  eq("one file: the first session's (the one left with /new was never written)", String(files().length), "1");
  w.host.roles.chat.submit("/title Hello world session");
  ok("/title names it, the tab following", await until(() => sessionRows().some((l) => l.includes("Hello world session"))));
  w.host.roles.chat.submit("/btw what was that?");
  ok("a side question in a fork, answered apart", await until(() => chat().some((l) => l.includes("│ You said: "))));
  ok("the fork's file removed after (--harness-forget)", await until(() => files().length === 1));

  w.host.kernel.stop();
  w.js.killProcesses();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
