// ffi: @light/plugins/native/ffi.json
// A turn Claude Code stopped at a rate limit: the limit is said as itself (not "Error: success"),
// and the request panel offers waiting, changing model (/model in the composer) or sending the
// message again when the limit resets. Limits are kept per agent (services/store.ts), so another
// agent's status does not show Claude Code's windows.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { Limits } from "../src/conversation/session-store.ts";
import { Answer, Reply } from "../src/conversation/requests.ts";
import { NOTICE } from "../src/conversation/model.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { createWidecode } from "../src/compose.ts";
import { Store } from "../src/services/store.ts";
import { done, eq, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

const limit = (): string => '{"type":"result","subtype":"success","is_error":true,"result":"You\'ve hit your session limit · resets 1pm (America/Sao_Paulo)"}';

/** Answer the open request with `label`. */
const choose = (c: Conversation, label: string): void => {
  const open = c.model.openRequests();
  if (open.length === 0) return;
  const reply = new Reply("answered");
  const a = new Answer(open[0].questions[0].question, false);
  a.labels.push(label);
  reply.answers.push(a);
  c.respond(open[0], reply);
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-limits-"));
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const app = createWidecode(ws, c, null);
  const now = Math.floor(Date.now() / 1000);
  c.receive('{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":' + String(now + 3600) + "}}}}");
  /** A turn open at the result, as a live one is. */
  const limitTurn = (): void => {
    c.model.openTurn("go", 0, true);
    c.receive(limit());
  };
  limitTurn();

  ok("the limit error is said as itself", await until(() => c.model.turns.some((t) => t.after.children.concat(t.body.children).some((i) => i.kind === NOTICE && i.text.includes("You've hit your session limit")))));
  ok("and not as an empty result", !c.model.turns.some((t) => t.after.children.concat(t.body.children).some((i) => i.kind === NOTICE && i.text === "Error: success")));
  ok("the limit is put to the user", await until(() => c.model.openRequests().length > 0));
  const asked = c.model.openRequests()[0];
  const labels = asked !== undefined ? asked.questions[0].options.map((o) => o.label) : [];
  eq("with waiting, changing model, or retrying", labels.slice(0, 2).join(" | "), "Wait | Change model");
  ok("and when the retry will come", labels.length === 3 && labels[2].startsWith("Retry in "));

  choose(c, "Wait");
  ok("waiting closes it and sends nothing", await until(() => c.model.openRequests().length === 0));
  eq("nothing was written to the agent", String(c.model.pending.length), "0");

  limitTurn();
  ok("another limit asks again", await until(() => c.model.openRequests().length > 0));
  choose(c, "Change model");
  ok("changing model puts /model in the composer", await until(() => app.chat.pane.input.value() === "/model "));

  limitTurn();
  ok("a third limit asks once more", await until(() => c.model.openRequests().length > 0));
  const third = c.model.openRequests()[0];
  choose(c, third !== undefined ? third.questions[0].options[2].label : "");
  ok("retrying is scheduled for the reset", await until(() => app.host.screen.message.peek().startsWith("retrying in ")));

  // A send from a finished task arrives while a retry waits: it does not fire messageSending, and
  // the retry still sends the user's message (not the task's report).
  const folder2 = mkdtempSync(join(tmpdir(), "widecode-limits-task-"));
  const fixture = join(folder2, "hold.ndjson");
  writeFileSync(fixture, '{"dir":"out","raw":"{\\"type\\":\\"system\\",\\"subtype\\":\\"status\\",\\"status\\":\\"requesting\\"}"}\n');
  const ws2 = await openWorkspace(folder2, 100);
  const c2 = new Conversation(ws2.folder);
  c2.executable = join(process.cwd(), "test", "fake-claude.mjs");
  c2.extraArgs.push("--fixture", fixture);
  const app2 = createWidecode(ws2, c2, null);
  const written: string[] = [];
  c2.onWrite = (line: string) => written.push(line);
  let sending = 0;
  app2.host.messageSending.add("test", () => {
    sending++;
  });
  const promptOf = (line: string): string => {
    const v = JSON.parse(line) as { message?: { content?: { type?: string; text?: string }[] } };
    for (const b of v.message?.content ?? []) if (b.type === "text" && typeof b.text === "string") return b.text;
    return "";
  };
  eq("the user's message is sent", c2.send("the user's message", []), "");
  c2.model.openTurn("go", 0, true);
  c2.receive('{"type":"result","subtype":"success","is_error":true,"result":"You\'ve hit your session limit · resets in 1 second"}');
  ok("a short limit is put to the user", await until(() => c2.model.openRequests().length > 0));
  const short = c2.model.openRequests()[0];
  choose(c2, short !== undefined ? short.questions[0].options[2].label : "");
  ok("the retry is scheduled", await until(() => app2.host.screen.message.peek().startsWith("retrying in ")));
  const answer = app2.js.answer("agent.send", JSON.stringify(["the task finished", { from: "task" }]));
  const sent = JSON.parse(answer.text) as { error: string };
  eq("a send from a task is accepted", sent.error, "");
  eq("and does not fire messageSending", String(sending), "0");
  ok("and the retry stays scheduled", app2.host.screen.message.peek().startsWith("retrying in "));
  ok("the retry fires and resends the user's message", await until(() => written.length > 0 && promptOf(written[written.length - 1]) === "the user's message", 12000));
  app2.host.kernel.stop();
  app2.js.killProcesses();
  ws2.close();
  rmSync(folder2, { recursive: true, force: true });

  // The windows are the agent's: Claude Code's are not another agent's.
  const home = mkdtempSync(join(tmpdir(), "widecode-limits-home-"));
  const store = new Store(home);
  const claude = new Limits();
  claude.fiveHour.usedPercent = 99;
  claude.fiveHour.resetsAt = now + 3600;
  store.saveLimits(claude, "claude");
  await app.host.useStore(store);
  eq("Claude's limit shows for Claude", String(c.info.fiveHourPct), "99");
  eq("another agent has its own (none yet)", app.host.session.useAgent("opencode") + " " + String(c.info.fiveHourPct), " -1");
  eq("and Claude's come back with Claude", app.host.session.useAgent("claude") + " " + String(c.info.fiveHourPct), " 99");
  rmSync(home, { recursive: true, force: true });

  app.host.kernel.stop();
  app.js.killProcesses();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exitCode = 1;
});
