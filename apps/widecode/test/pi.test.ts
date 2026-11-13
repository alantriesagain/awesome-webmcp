// ffi: @light/plugins/native/ffi.json
// An agent over pi's RPC mode (plugins/pi/index.ts), here the fake (test/fake-pi.mjs) from the plugin's
// section: its session, its model and thinking levels as the model and effort, its commands as the
// session's slash commands; a reply and its thinking; a bash call with its output; an edit with its
// diff, followed by the code column; steering a message into a turn that runs; abort; an error; its
// sessions listed from pi's folder, one pressed and resumed with --session; each extension UI method
// through the request panel or the screen; and the plugin absent when its program is not on PATH.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { Answer, Reply } from "@widecode/conversation/requests.ts";
import { Item, NOTICE, TEXT, THINKING, TOOL, Turn } from "@widecode/conversation/model.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { SegmentContext } from "@widecode/screen/contributions.ts";
import { composeWidecode } from "../src/compose.ts";
import { JsBand } from "../src/runtime/views.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

const kinds = (items: Item[]): string => items.map((i: Item) => (i.kind === THINKING ? "thinking" : i.kind === TEXT ? "text" : i.kind === TOOL ? "tool" : i.kind === NOTICE ? "notice:" + i.text : "other")).join(",");

const main = async (): Promise<void> => {
  const home = mkdtempSync(join(tmpdir(), "widecode-pi-home-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const folder = mkdtempSync(join(tmpdir(), "widecode-pi-"));
  writeFileSync(join(folder, "a.txt"), "one\n");
  // A session pi made earlier, with no name: its title is its first user message.
  const safe = folder.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  const sdir = join(home, ".pi", "agent", "sessions", "--" + safe + "--");
  mkdirSync(sdir, { recursive: true });
  writeFileSync(
    join(sdir, "2026-10-14T10-00-00-000Z_past-1.jsonl"),
    JSON.stringify({ type: "session", version: 3, id: "past-1", timestamp: "2026-10-14T10:00:00.000Z", cwd: folder }) + "\n" + JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-10-14T10:00:01.000Z", message: { role: "user", content: "Earlier question", timestamp: Date.parse("2026-10-14T10:00:01.000Z") } }) + "\n",
  );
  const log = join(folder, "fake.log");
  const fake = join(process.cwd(), "test/fake-pi.mjs");
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  w.host.session.agentId.value = "pi";
  const config: unknown = { pi: { name: "pi", command: ["node", fake, "--log", log] } };
  w.start(config, new NoStateFile(), []);
  c.prepare();
  await w.host.load();
  const idle = (): boolean => !c.model.running && c.model.pending.length === 0;
  const last = (): Turn => c.model.turns[c.model.turns.length - 1];
  const sent = (): string => readFileSync(log, "utf8");
  const chat = (): string[] => {
    const s = w.chat.pane.source;
    s.prepare(80);
    const out: string[] = [];
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 80).runs.map((r: Run) => r.text).join("").replace(/\s+$/, ""));
    return out;
  };
  const turn = async (text: string): Promise<boolean> => {
    const before = c.model.turns.length;
    w.host.roles.chat.submit(text);
    return until(() => c.model.turns.length > before && idle());
  };
  const sessionRows = (): string[] => {
    const p = w.host.screen.findPanel("sessions");
    const out: string[] = [];
    if (p === null) return out;
    const s = p.view.source;
    s.prepare(60);
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 60).runs.map((r: Run) => r.text).join("").trim());
    return out;
  };
  const pressSession = (text: string): void => {
    const p = w.host.screen.findPanel("sessions");
    const at = sessionRows().findIndex((l: string) => l.includes(text));
    if (p !== null && at >= 0) p.press(at, 0);
    const open = w.host.kernel.actions.find("sessions.resume");
    if (open !== null) open.onRun(new KeyEvent("enter", "", false, false, false), 1);
  };
  const segmentText = (name: string): string => {
    const seg = w.host.screen.segments.find(name);
    return seg === null ? "" : seg.draw(new SegmentContext()).map((r) => r.text).join("");
  };
  const bandText = (id: string): string => {
    const band = w.host.screen.band.find((b) => b.id === id);
    if (band === undefined) return "";
    return (band.view as JsBand).lines(40).map((l) => l.runs.map((r: Run) => r.text).join("")).join(" ");
  };
  const uiTurn = async (text: string, replyOf: (question: string) => Reply): Promise<boolean> => {
    const before = c.model.turns.length;
    w.host.roles.chat.submit(text);
    const asked = await until(() => c.model.openRequests().length === 1);
    if (!asked) return false;
    const req = c.model.openRequests()[0];
    c.respond(req, replyOf(req.questions[0].question));
    return until(() => c.model.turns.length > before && idle());
  };
  const answerWith = (question: string, label: string): Reply => {
    const r = new Reply("answered");
    const a = new Answer(question, false);
    a.labels.push(label);
    r.answers.push(a);
    return r;
  };

  eq("the agent from the section", c.agent.id() + " " + c.agent.name(), "pi pi");
  ok("named on the screen", w.chat.pane.input.placeholder.startsWith("Write to pi."));
  ok("its session starts with widecode: its model, efforts and commands before any message", (await until(() => c.info.modelId === "fake/small" && c.started && c.agent.choices().efforts.map((e) => e.value).join(",") === "low,high,default" && c.model.slashCommands.join(",") === "init,review,skill:alpha")) && sent().includes('"type":"get_state"') && !sent().includes('"type":"prompt"'));
  ok("a session file of its own", c.sessionId.startsWith("pi-"));
  w.host.screen.showPanel("sessions");
  ok("its sessions in the Sessions tab, from pi's folder", await until(() => sessionRows().some((l: string) => l.includes("Earlier question"))));

  ok("a turn", await turn("hello"));
  ok("the prompt and the reply from two chunks", await until(() => chat().some((l: string) => l.includes("<Me>: hello")) && chat().some((l: string) => l.includes("Hello, world."))));
  eq("its thinking, then its text", kinds(last().body.children), "thinking,text");
  eq("the session's model, effort and commands", c.info.modelId + " " + c.info.effort + " " + c.model.slashCommands.join(","), "fake/small default init,review,skill:alpha");
  const ended = last().result;
  eq("the turn's end", ended === null ? "none" : String(ended.isError), "false");

  ok("a bash call", await turn("run"));
  const run = c.model.tool("call_run");
  eq("its kind, name, command, output and no file", run === null || run.result === null ? "" : [run.category, run.name, run.summary, run.command, run.result.text, String(run.paths.length)].join(" | "), "run | Bash | ls -1 | ls -1 | a.txt\nb.txt | 0");
  eq("counted as a run", String(c.info.execs) + "/" + String(c.info.calls), "1/1");

  ok("a write and a read back, as the live run had them", await turn("write"));
  const write = c.model.tool("call_write");
  eq("the write's card, its result and its content", write === null || write.result === null ? "" : [write.category, write.name, write.paths.join(","), write.result.text, write.written].join(" | "), "edit | Write | hello.txt | Successfully wrote to hello.txt | hi\n");
  const read = c.model.tool("call_read");
  eq("the read back: a read, its file and its text", read === null || read.result === null ? "" : [read.category, read.name, read.summary, read.result.text].join(" | "), "read | Read | hello.txt from line 1 | hi\n");
  ok("the live run's reply", chat().some((l: string) => l.includes("done")));
  eq("the code column follows the write", c.model.lastEdit, join(folder, "hello.txt"));
  eq("each message's cost adds to the session's", c.info.costUsd.toFixed(3), "0.006");

  ok("an edit", await turn("edit"));
  const edit = c.model.tool("call_edit");
  const hunks = edit === null || edit.result === null ? "" : edit.result.patch.map((h) => String(h.oldStart) + "," + String(h.newStart) + ":" + h.lines.join("|")).join(" ");
  eq("its file, its line and its diff", edit === null || edit.result === null ? "" : edit.category + " " + edit.paths.join(",") + " " + edit.summary + " " + hunks, "edit a.txt a.txt  +2 -1 1,1:-one|+one|+two");
  eq("the code column follows it", c.model.lastEdit, join(folder, "a.txt"));

  c.setModel("fake/large");
  ok("a model it has", (await until(() => c.info.modelId === "fake/large")) && sent().includes('"type":"set_model"') && sent().includes('"provider":"fake"') && sent().includes('"modelId":"large"'));
  c.setEffort("high");
  ok("an effort it has", (await until(() => c.info.effort === "high")) && sent().includes('"type":"set_thinking_level"') && sent().includes('"level":"high"'));

  w.host.roles.chat.submit("work");
  ok("a long turn", await until(() => c.model.tool("call_work") !== null));
  w.host.roles.chat.submit("go left");
  ok("a message meanwhile is steered into it", c.model.running && sent().includes('"streamingBehavior":"steer"'));
  const workAt = c.model.turns.length - 1;
  ok("the turn ends with it", await until(() => c.model.turns.length > workAt && idle()) && chat().some((l: string) => l.includes("Worked. Also: go left")));

  w.host.roles.chat.submit("slow");
  ok("a turn that waits", await until(() => c.model.running && chat().some((l: string) => l.includes("Working…"))));
  const slowAt = c.model.turns.length - 1;
  c.interrupt();
  ok("Esc cancels it", await until(() => c.model.turns.length > slowAt && idle()));
  const stopped = last().result;
  eq("cancelled", stopped === null ? "" : stopped.subtype, "cancelled");
  ok("abort was sent", sent().includes('"type":"abort"'));

  ok("an error", await turn("fail"));
  ok("the turn failed", last().result !== null && last().result?.isError === true);

  ok("select: an option answered", (await uiTurn("select", (q: string) => answerWith(q, "Allow"))) && chat().some((l: string) => l.includes("Selected: Allow")));
  ok("confirm: answered yes", (await uiTurn("confirm", (q: string) => answerWith(q, "Yes"))) && chat().some((l: string) => l.includes("Confirmed: true")));
  ok("input: cancelled", (await uiTurn("input", () => new Reply("cancelled"))) && chat().some((l: string) => l.includes("Input cancelled")));
  ok("editor: text answered", (await uiTurn("editor", () => {
    const r = new Reply("answered");
    const a = new Answer("Edit some text", false);
    a.text = "edited text";
    r.answers.push(a);
    return r;
  })) && chat().some((l: string) => l.includes("Editor: edited text")));

  ok("notify: a notice", (await turn("notify")) && w.host.screen.message.peek().includes("pi says hi"));
  ok("setStatus: a segment keyed by its key", (await turn("status")) && segmentText("pi:pi-test") === "busy");
  ok("setStatus without a text clears it", (await turn("status-clear")) && segmentText("pi:pi-test") === "");
  ok("setWidget: a band strip keyed by its key", (await turn("widget")) && bandText("pi:pi-widget") === "line one line two");
  ok("setWidget without lines clears it", (await turn("widget-clear")) && bandText("pi:pi-widget") === "");
  ok("setTitle: the session's title", (await turn("title")) && c.title === "pi session");
  ok("set_editor_text: the composer", (await turn("editor-text")) && w.chat.pane.input.value() === "draft from pi");

  pressSession("Earlier question");
  ok("a past session pressed in the tab", await until(() => c.agent.sessionId() === "past-1" && c.started && idle()));
  ok("resumed with --session", sent().includes('"--session"'));
  ok("a message goes to it", (await turn("hi")) && chat().some((l: string) => l.includes("You said: hi")));

  w.host.kernel.stop();
  w.js.killProcesses();

  const c2 = new Conversation(ws.folder);
  const w2 = composeWidecode(ws, c2);
  const absent: unknown = { pi: { command: ["no-such-pi-binary", "--mode", "rpc"] } };
  w2.start(absent, new NoStateFile(), []);
  await w2.host.load();
  ok("absent when no pi is on PATH", w2.host.session.useAgent("pi").startsWith("no agent named pi"));
  w2.host.kernel.stop();

  ws.close();
  rmSync(folder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
