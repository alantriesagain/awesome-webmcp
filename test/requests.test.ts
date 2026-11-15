// ffi: @light/plugins/native/ffi.json
// Claude's requests answered through the app's panel, headlessly, against recorded traffic: the
// fake CLI replays each fixture to its request (Claude Code's plugin starting it on the recorded
// message, plan mode first where the recording has it), the panel driven with keys and the
// composer as a user would, and the line the plugin writes to the CLI compared byte for byte with
// what the probe sent (and Claude accepted): a single choice by number, a multi-select with Space
// plus an answer in the user's own words, and a plan approval that returns to bypass mode.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWidecode, Widecode } from "../src/compose.ts";
import { Conversation } from "../src/conversation/conversation.ts";
import { TOOL } from "../src/conversation/model.ts";
import { Choice, Question } from "../src/conversation/requests.ts";
import { Caret, Clip, DEFAULT_STYLE, KeyEvent, Screen, TRoot, frames, layout, mount, paint, unmount } from "@lightstart/light/native/tui";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const fixtures = join(process.cwd(), "test", "fixtures");
const W = 160;
const H = 30;

interface Frame {
  dir?: unknown;
  raw?: unknown;
}

const frame = (line: string): Frame => JSON.parse(line) as Frame;
const key = (name: string, text: string): KeyEvent => new KeyEvent(name, text, false, false, false);

const fake = join(process.cwd(), "test", "fake-claude.mjs");

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

/** The recording's inputs: whether it switches to plan mode first, and the message it sends. */
const opening = (name: string): string[] => {
  const out: string[] = [];
  for (const line of readFileSync(join(fixtures, name + ".ndjson"), "utf8").split("\n")) {
    if (line.length === 0) continue;
    const f = frame(line);
    const raw = typeof f.raw === "string" ? f.raw : "";
    if (f.dir !== "in") continue;
    if (raw.includes('"set_permission_mode"')) out.push("plan");
    else if (raw.startsWith('{"type":"user"')) {
      const m = JSON.parse(raw) as { message?: { content?: { text?: string }[] } };
      out.push((m.message?.content ?? [])[0]?.text ?? "");
      return out;
    }
  }
  return out;
};

const recorded = (name: string): string => {
  for (const line of readFileSync(join(fixtures, name + ".ndjson"), "utf8").split("\n")) {
    if (line.length === 0) continue;
    const f = frame(line);
    const raw = typeof f.raw === "string" ? f.raw : "";
    if (f.dir === "in" && raw.startsWith('{"type":"control_response"')) return raw;
  }
  return "";
};

const main = async (): Promise<void> => {
  const ws = await openWorkspace(process.cwd(), 100);
  const root = new TRoot();
  const screen = (): string => {
    for (let i = 0; i < 3; i++) {
      frames.flush();
      layout(root, W, H, DEFAULT_STYLE);
    }
    const s = new Screen(W, H);
    paint(root, s, new Clip(0, 0, W, H), DEFAULT_STYLE, new Caret(), null);
    return s.text();
  };
  const run = async (name: string, drive: (app: Widecode) => void): Promise<string> => {
    const conversation = new Conversation(ws.folder);
    conversation.executable = fake;
    conversation.extraArgs.push("--fixture", join(fixtures, name + ".ndjson"));
    const written: string[] = [];
    conversation.onWrite = (line: string) => written.push(line);
    const app = createWidecode(ws, conversation, null);
    app.shell.resize(W);
    mount(app.shell, root);
    for (const step of opening(name)) {
      if (step === "plan") conversation.setMode("plan");
      else conversation.send(step, []);
    }
    for (let i = 0; i < 500 && conversation.model.openRequests().length === 0; i++) await wait(20);
    conversation.changed();
    drive(app);
    unmount(app.shell);
    conversation.kill();
    app.host.kernel.stop();
    app.js.killProcesses();
    return written.length > 0 ? written[written.length - 1] : "";
  };

  const single = await run("ask", (app: Widecode) => {
    const text = screen();
    ok("the question shows in the panel with its options", text.includes("Claude asks · Color") && text.includes("Which color do you prefer?") && text.includes("2. Blue"));
    app.shell.handleKey(key("char", "2"));
    ok("the panel closes once answered", !screen().includes("Claude asks · Color"));
  });
  eq("a single choice by number: the exact response", single, recorded("ask"));

  const multi = await run("ask-multi", (app: Widecode) => {
    ok("two questions, the first a multi-select", screen().includes("Claude asks (1/2) · Fruits") && screen().includes("[ ] Apple"));
    ok("the strip names every question of the set", screen().includes("Fruits  Color"));
    app.shell.handleKey(key("char", " "));
    app.shell.handleKey(key("down", ""));
    app.shell.handleKey(key("char", " "));
    ok("Space marks options", screen().includes("[x] Apple") && screen().includes("[x] Pear"));
    app.shell.handleKey(key("enter", ""));
    ok("then the second question, the first ticked in the strip", screen().includes("Claude asks (2/2) · Color") && screen().includes("✓ Fruits  Color"));
    app.shell.handleKey(key("left", ""));
    ok("← goes back to the answered question with its marks", screen().includes("Claude asks (1/2) · Fruits") && screen().includes("[x] Apple") && screen().includes("[x] Pear"));
    app.shell.handleKey(key("down", ""));
    app.shell.handleKey(key("down", ""));
    app.shell.handleKey(key("char", " "));
    ok("a mark changed", screen().includes("[x] Plum"));
    app.shell.handleKey(key("char", " "));
    ok("and changed back", screen().includes("[ ] Plum"));
    app.shell.handleKey(key("enter", ""));
    ok("answering again replaces the answer and moves to the question still open", screen().includes("Claude asks (2/2) · Color"));
    app.shell.handleKey(key("right", ""));
    ok("→ past the last question wraps to the first", screen().includes("Claude asks (1/2) · Fruits"));
    app.shell.handleKey(key("right", ""));
    ok("and → again returns to the open one", screen().includes("Claude asks (2/2) · Color"));
    app.chat.typed("my own words: purple");
  });
  eq("a multi-select and an answer in the user's words: the exact response", multi, recorded("ask-multi"));

  const plan = await run("plan", (app: Widecode) => {
    ok("the plan panel asks to start", screen().includes("Plan ready") && screen().includes("1. Yes, start"));
    app.shell.handleKey(key("enter", ""));
  });
  eq("a plan approval returns to bypass mode: the exact response", plan, recorded("plan"));

  const rejected = await run("plan", (app: Widecode) => {
    app.shell.handleKey(key("down", ""));
    app.chat.typed("Use a heredoc instead.");
  });
  ok("keep planning sends the feedback as a denial", rejected.includes('"behavior":"deny","message":"Use a heredoc instead."'));

  // An interrupt while a question waits: the turn's result withdraws it and the panel closes.
  await run("ask", (app: Widecode) => {
    ok("the panel is open", screen().includes("Claude asks · Color"));
    app.host.conversation.receive('{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","session_id":"s"}');
    app.host.conversation.changed();
    const text = screen();
    ok("the turn's end withdraws the question and closes the panel", !text.includes("Claude asks · Color") && text.includes("◆ Claude asks  withdrawn"));
  });
  // A line the user typed or queued before a request opened is a message, never its answer.
  const c3 = new Conversation(ws.folder);
  const app3 = createWidecode(ws, c3, null);
  const root3 = new TRoot();
  app3.shell.resize(W);
  mount(app3.shell, root3);
  const sent3: string[] = [];
  app3.chat.onLine = (text: string) => sent3.push(text);
  const input3 = app3.chat.pane.input;
  input3.lines = ["typed before it opened"];
  c3.receive('{"type":"control_request","request_id":"q-1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which?","header":"Q","options":[{"label":"A"},{"label":"B"}]}]}}}');
  c3.changed();
  eq("the question's panel opened", app3.chat.pane.panel.item?.requestId ?? "none", "q-1");
  app3.chat.typed("typed before it opened");
  eq("text typed before the panel opened is a message to the agent", sent3.join(",") + " " + String(c3.model.openRequests().length), "typed before it opened 1");
  app3.chat.submit("a queued message");
  eq("a queued message stays a message too", sent3.join(",") + " " + String(c3.model.openRequests().length), "typed before it opened,a queued message 1");
  app3.chat.typed("A");
  eq("text typed while the panel is shown answers it", String(sent3.length) + " " + String(c3.model.openRequests().length), "2 0");
  unmount(app3.shell);
  c3.kill();
  app3.host.kernel.stop();
  app3.js.killProcesses();

  // A permission's panel offers its options alone; free words are refused, the request still open.
  const c4 = new Conversation(ws.folder);
  const app4 = createWidecode(ws, c4, null);
  const root4 = new TRoot();
  app4.shell.resize(W);
  mount(app4.shell, root4);
  const paint4 = (): string => {
    for (let i = 0; i < 3; i++) {
      frames.flush();
      layout(root4, W, H, DEFAULT_STYLE);
    }
    const s = new Screen(W, H);
    paint(root4, s, new Clip(0, 0, W, H), DEFAULT_STYLE, new Caret(), null);
    return s.text();
  };
  const requested = c4.model.openRequest("p-1", "Bash", "", null);
  requested.category = "permission";
  requested.permission = true;
  const permissionQuestion = new Question();
  permissionQuestion.question = "Bash ls: allow it?";
  permissionQuestion.header = "Permission";
  permissionQuestion.options.push(new Choice("Allow once", ""));
  permissionQuestion.options.push(new Choice("Deny", ""));
  requested.questions.push(permissionQuestion);
  c4.changed();
  ok("a permission panel has no row of the user's own words", !paint4().includes("Something else") && requested.permission && requested.category === "permission");
  app4.chat.typed("let it run");
  ok("free words are refused with a line, the permission still open", requested.state === "open" && app4.chat.pane.panel.active && paint4().includes("Choose one of the options"));
  unmount(app4.shell);
  c4.kill();
  app4.host.kernel.stop();
  app4.js.killProcesses();

  // A background subagent's question opens its panel though its card is in an earlier turn; a
  // second request says how many more wait in the title.
  const c5 = new Conversation(ws.folder);
  const app5 = createWidecode(ws, c5, null);
  const root5 = new TRoot();
  app5.shell.resize(W);
  mount(app5.shell, root5);
  const paint5 = (): string => {
    for (let i = 0; i < 3; i++) {
      frames.flush();
      layout(root5, W, H, DEFAULT_STYLE);
    }
    const s = new Screen(W, H);
    paint(root5, s, new Clip(0, 0, W, H), DEFAULT_STYLE, new Caret(), null);
    return s.text();
  };
  const m5 = c5.model;
  m5.openTurn("delegate", 0, true);
  const card = m5.block("", "tc-bg", TOOL, "toolu-bg", "Task", "");
  m5.closeTurn(null);
  for (const text of ["one", "two"]) {
    m5.openTurn(text, 0, true);
    m5.closeTurn(null);
  }
  m5.openTurn("now", 0, true);
  c5.changed();
  const late = m5.openRequest("req-bg", "Task", "", null, card !== null ? "toolu-bg" : "");
  const lateQuestion = new Question();
  lateQuestion.question = "rm a.txt: allow it?";
  lateQuestion.header = "Permission";
  lateQuestion.options.push(new Choice("Allow once", ""));
  lateQuestion.options.push(new Choice("Reject", ""));
  late.questions.push(lateQuestion);
  late.category = "question";
  c5.changed();
  ok("a question under an earlier turn's card opens the panel", app5.chat.pane.panel.item === late && paint5().includes("rm a.txt: allow it?"));
  const other = m5.openRequest("req-2", "Bash", "", null);
  const otherQuestion = new Question();
  otherQuestion.question = "Bash rm: allow it?";
  otherQuestion.options.push(new Choice("Allow once", ""));
  other.questions.push(otherQuestion);
  other.category = "question";
  c5.changed();
  ok("another request waits, the title says so", paint5().includes("1 more waiting"));
  unmount(app5.shell);
  c5.kill();
  app5.host.kernel.stop();
  app5.js.killProcesses();

  ws.close();
  done();
};

main();
