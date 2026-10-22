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
import { Conversation } from "@widecode/conversation/conversation.ts";
import { Caret, Clip, DEFAULT_STYLE, KeyEvent, Screen, TRoot, frames, layout, mount, paint, unmount } from "@bootstrapp/light/native/tui";
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
    app.chat.submit("my own words: purple");
  });
  eq("a multi-select and an answer in the user's words: the exact response", multi, recorded("ask-multi"));

  const plan = await run("plan", (app: Widecode) => {
    ok("the plan panel asks to start", screen().includes("Plan ready") && screen().includes("1. Yes, start"));
    app.shell.handleKey(key("enter", ""));
  });
  eq("a plan approval returns to bypass mode: the exact response", plan, recorded("plan"));

  const rejected = await run("plan", (app: Widecode) => {
    app.shell.handleKey(key("down", ""));
    app.chat.submit("Use a heredoc instead.");
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
  ws.close();
  done();
};

main();
