// ffi: @lightstart/plugins/native/ffi.json
// Claude Code's CLI as its plugin runs it (plugins/claude/index.ts), against a fake CLI replaying recorded
// traffic that checks what it is sent: a message starts it, a permission prompt goes to the request
// panel and the user's allow reaches the CLI with the tool's own input (byte for byte, the fake's
// --strict), AskUserQuestion is left to the request panel and the user's answer reaches the CLI, the session id comes from init
// and result, and a mode change before the first message is written before it, the CLI's lines
// coming on after it. Runs under node and natively.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Answer, Reply } from "../src/conversation/requests.ts";
import type { Widecode } from "../src/compose.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";

const fixtures = join(process.cwd(), "test", "fixtures");
const fake = join(process.cwd(), "test", "fake-claude.mjs");

class Outcome {
  logs: string[] = [];
  written: string[] = [];
  sessionId = "";
  turnEnded = false;
  asked = "";
  stopped = false;
}

/** A message to the fake replaying fixture `name`; a question answered when `answer`; then its input closed. */
const run = async (name: string, strict: boolean, answer: boolean): Promise<Outcome> => {
  const out = new Outcome();
  const folder = mkdtempSync(join(tmpdir(), "widecode-session-"));
  const w = await openWidecode({
    folder,
    before: (w: Widecode) => {
      const c = w.host.conversation;
      c.executable = fake;
      c.extraArgs.push("--fixture", join(fixtures, name + ".ndjson"));
      if (strict) c.extraArgs.push("--strict");
      c.onWrite = (line: string) => out.written.push(line);
    },
  });
  const c = w.host.conversation;
  w.host.onLog = (text: string) => out.logs.push(text);
  c.send("go", []);
  if (answer) {
    await until(() => c.model.openRequests().length > 0, 10000);
    const asked = c.model.openRequests();
    if (asked.length > 0) {
      out.asked = asked[0].name;
      const reply = new Reply("answered");
      const a = new Answer(asked[0].questions[0].question, false);
      a.labels.push(asked[0].questions[0].options[0].label);
      reply.answers.push(a);
      c.respond(asked[0], reply);
    }
  }
  // The turn ended: its result came (a recording without messages opens no turn; its API time shows it).
  out.turnEnded = await until(() => !c.model.running && (c.model.turns.some((t) => t.result !== null) || c.info.apiMs > 0), 15000);
  out.sessionId = c.sessionId;
  c.stop();
  out.stopped = await until(() => out.logs.some((l: string) => l.startsWith("claude exited with code")), 8000);
  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  return out;
};

const main = async (): Promise<void> => {
  const allow = await run("fake-allow", true, true);
  ok("its result came", allow.turnEnded);
  eq("the Write prompt was put to the user as a permission, who allowed it", allow.asked + " " + String(allow.logs.includes("claude: Write allowed by the user")), "Write true");
  eq("session id from init and result", allow.sessionId, "11111111-2222-3333-4444-555555555555");
  ok("the fake saw every input it expected, byte for byte, and exited 0", allow.logs.includes("claude exited with code 0"));

  const ask = await run("ask", false, true);
  eq("AskUserQuestion was left to the request panel", ask.asked + " " + String(ask.logs.some((l: string) => l.includes("allowed AskUserQuestion"))), "AskUserQuestion false");
  ok("the answer was accepted and the turn ended", ask.turnEnded && ask.logs.includes("claude exited with code 0"));
  ok("the session id came from the recording", ask.sessionId.length === 36);

  // Plan mode first: a control request starts the CLI and goes before the message. The CLI's first
  // lines then include `"status":null`, which once stopped the stream while a decoder cast it.
  const folder = mkdtempSync(join(tmpdir(), "widecode-session-"));
  const written: string[] = [];
  const w = await openWidecode({
    folder,
    before: (w: Widecode) => {
      const c = w.host.conversation;
      c.executable = fake;
      c.extraArgs.push("--fixture", join(fixtures, "plan.ndjson"));
      c.onWrite = (line: string) => written.push(line);
    },
  });
  const c = w.host.conversation;
  eq("plan mode before any message: the CLI starts", c.setMode("plan"), "");
  c.send("plan it", []);
  eq("its mode change, then the message", written.map((l: string) => (l.includes('"set_permission_mode"') ? "mode" : l.startsWith('{"type":"user"') ? "message" : "other")).join(","), "mode,message");
  ok("the CLI's lines keep coming: the plan is asked for", await until(() => c.model.openRequests().some((r) => r.name === "ExitPlanMode"), 10000));
  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
