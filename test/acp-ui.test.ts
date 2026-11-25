// ffi: @lightstart/plugins/native/ffi.json
// The extension UI of an agent over ACP (plugins/acp/index.ts), `_lightcode/ui` as lightcode and the fake
// (test/fake-acp.mjs) agree it: the capability in initialize; a select, a confirm, an input and an
// editor in the request panel, the answers the agent hears, a dialog withdrawn by Esc and one that
// times out; notify as a status message and a notice; setStatus as a segment keyed by its key and
// setWidget as a band strip, cleared when the session ends; setTitle and set_editor_text. A Task
// run on an ACP target is a run with no user: every dialog it is asked is answered cancelled.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type IncomingMessage } from "node:http";
import { Answer, Reply } from "../src/conversation/requests.ts";
import { TOOL, Turn } from "../src/conversation/model.ts";
import { SegmentContext } from "../src/screen/contributions.ts";
import type { Lightcode } from "../src/compose.ts";
import { JsBand } from "../src/runtime/views.ts";
import { closeLightcode, openLightcode } from "./support/app.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";

const send = (url: string, token: string, body: string): Promise<string> =>
  new Promise((resolve) => {
    const port = Number(url.slice(url.lastIndexOf(":") + 1, url.lastIndexOf("/")));
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + token };
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: headers }, (res: IncomingMessage) => {
      const parts: string[] = [];
      res.on("data", (c: Buffer) => parts.push(c.toString("utf8")));
      res.on("end", () => resolve(String(res.statusCode) + " " + parts.join("")));
    });
    req.on("error", (e: Error) => resolve("error " + e.message));
    req.end(body);
  });

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "lightcode-acp-ui-"));
  const log = join(folder, "fake.log");
  const fake = join(process.cwd(), "test/fake-acp.mjs");
  const config: unknown = {
    acp: {
      agents: { fake: { name: "Fake", command: ["node", fake, "--log", log] } },
      tasks: { targets: { deepseek: { agent: "fake" } }, maxConcurrent: 1 },
    },
  };
  const w = await openLightcode({
    folder,
    plugins: config,
    load: true,
    before: (w: Lightcode) => {
      w.host.session.agentId.value = "fake";
    },
  });
  const c = w.host.conversation;
  c.prepare();
  const idle = (): boolean => !c.model.running && c.model.pending.length === 0;
  const last = (): Turn => c.model.turns[c.model.turns.length - 1];
  const sent = (): string => (existsSync(log) ? readFileSync(log, "utf8") : "");
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
    c.respond(c.model.openRequests()[0], replyOf(c.model.openRequests()[0].questions[0].question));
    return until(() => c.model.turns.length > before && idle());
  };
  const answerWith = (question: string, label: string): Reply => {
    const r = new Reply("answered");
    const a = new Answer(question, false);
    a.labels.push(label);
    r.answers.push(a);
    return r;
  };

  ok("initialize says lightcode takes extension UI", await until(() => sent().includes('"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"_meta":{"lightcode":{"ui":true}}}')));

  ok("select: an option answered", (await uiTurn("select", (q: string) => answerWith(q, "Allow"))) && chat().some((l: string) => l.includes("Selected: Allow")));
  ok("confirm: answered yes", (await uiTurn("confirm", (q: string) => answerWith(q, "Yes"))) && chat().some((l: string) => l.includes("Confirmed: true")));
  ok("input: cancelled", (await uiTurn("input", () => new Reply("cancelled"))) && chat().some((l: string) => l.includes("Input cancelled")));
  ok(
    "editor: text answered",
    (await uiTurn("editor", () => {
      const r = new Reply("answered");
      const a = new Answer("Edit some text", false);
      a.text = "edited text";
      r.answers.push(a);
      return r;
    })) && chat().some((l: string) => l.includes("Editor: edited text")),
  );

  // Esc withdraws a dialog the turn is waiting on.
  w.host.roles.chat.submit("select");
  ok("a dialog open, Esc withdraws it", (await until(() => c.model.openRequests().length === 1)) && idle() === false);
  const withdrawnAt = c.model.turns.length - 1;
  c.interrupt();
  ok("the agent hears cancelled", await until(() => c.model.turns.length > withdrawnAt && idle() && chat().some((l: string) => l.includes("Select cancelled"))));
  eq("the turn says it was interrupted", last().result?.subtype ?? "", "cancelled");

  w.host.roles.chat.submit("timeout");
  ok("a dialog times out", await until(() => chat().some((l: string) => l.includes("Input timed out")) && idle()));
  eq("cancelled", last().result?.subtype ?? "", "cancelled");

  ok("notify: info is a status message", (await turn("notify")) && w.host.screen.message.peek().includes("fake says hi"));
  ok("notify: error is a notice", chat().some((l: string) => l.includes("Fake: things went wrong")));

  ok("setStatus: a segment keyed by its key", (await turn("status")) && segmentText("acp:test") === "busy");
  ok("setStatus without a text clears it", (await turn("status-clear")) && segmentText("acp:test") === "");
  ok("setWidget: a band strip keyed by its key", (await turn("widget")) && bandText("acp:widget") === "line one line two");
  ok("setWidget without lines clears it", (await turn("widget-clear")) && bandText("acp:widget") === "");
  ok("setTitle: the session's title", (await turn("title")) && c.title === "fake session");
  ok("set_editor_text: the composer", (await turn("editor-text")) && w.chat.pane.input.value() === "draft from fake");

  // What the agent put on the screen goes when its session ends.
  ok("a status and a strip to clear", (await turn("status")) && (await turn("widget")) && segmentText("acp:test") === "busy" && bandText("acp:widget") === "line one line two");
  c.reset();
  eq("the session's end clears them", segmentText("acp:test") + "|" + bandText("acp:widget"), "|");

  // A Task run on an ACP target hears no user: its dialogs are cancelled.
  const url = await w.js.mcp.start();
  const token = w.js.mcp.tokenFor("claude");
  c.model.openTurn("main", 0, true);
  const call = c.model.block("", "tc", TOOL, "toolu-ui", "Task", "");
  ok("the Task call is made", call !== null);
  const reply = await send(url, token, '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"Task","arguments":{"description":"ask a dialog","prompt":"select","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-ui"}}}');
  ok("the background-task client answers a dialog cancelled", reply.includes("Select cancelled"));
  const initializes = (): string[] => sent().split("\n").filter((l: string) => l.includes('"method":"initialize"'));
  ok("only the main client claims the UI capability", String(initializes().filter((l: string) => l.includes('"lightcode":{"ui":true}')).length) === "1" && initializes().length >= 2);
  ok("the run's answer was cancelled", sent().includes('"result":{"cancelled":true}'));

  closeLightcode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
