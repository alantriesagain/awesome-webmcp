// ffi: @lightstart/plugins/native/ffi.json
// A turn Claude Code stopped at a rate limit: the limit is said as itself (not "Error: success"),
// and the message is sent again automatically when the limit resets, with no question to answer.
// Limits are kept per agent (services/store.ts), so another agent's status does not show Claude
// Code's windows.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { Limits } from "../src/conversation/session-store.ts";
import { NOTICE } from "../src/conversation/model.ts";
import type { Widecode } from "../src/compose.ts";
import { Store } from "../src/services/store.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";

const limit = (): string => '{"type":"result","subtype":"success","is_error":true,"result":"You\'ve hit your session limit · resets 1pm (America/Sao_Paulo)"}';

/** Whether the conversation said a notice whose text includes `text`. */
const said = (c: Conversation, text: string): boolean =>
  c.model.turns.some((t) => t.after.children.concat(t.body.children).some((i) => i.kind === NOTICE && i.text.includes(text)));

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-limits-"));
  const app = await openWidecode({ folder });
  const c = app.host.conversation;
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
  ok("no question is put to the user", await until(() => app.host.screen.message.peek().startsWith("retrying in ")) && c.model.openRequests().length === 0);
  ok("a retry is scheduled automatically for the reset", said(c, "Retry scheduled when the limit resets"));

  // A send from a finished task arrives while a retry waits: it does not fire messageSending, and
  // the retry still sends the user's message (not the task's report).
  const folder2 = mkdtempSync(join(tmpdir(), "widecode-limits-task-"));
  const fixture = join(folder2, "hold.ndjson");
  writeFileSync(fixture, '{"dir":"out","raw":"{\\"type\\":\\"system\\",\\"subtype\\":\\"status\\",\\"status\\":\\"requesting\\"}"}\n');
  const app2 = await openWidecode({
    folder: folder2,
    before: (app2: Widecode) => {
      app2.host.conversation.executable = join(process.cwd(), "test", "fake-claude.mjs");
      app2.host.conversation.extraArgs.push("--fixture", fixture);
    },
  });
  const c2 = app2.host.conversation;
  const written: string[] = [];
  c2.onWrite = (line: string) => written.push(line);
  let sending = 0;
  app2.host.session.messageSending.on(() => {
    sending++;
  }, "test");
  const promptOf = (line: string): string => {
    const v = JSON.parse(line) as { message?: { content?: { type?: string; text?: string }[] } };
    for (const b of v.message?.content ?? []) if (b.type === "text" && typeof b.text === "string") return b.text;
    return "";
  };
  eq("the user's message is sent", c2.send("the user's message", []), "");
  c2.model.openTurn("go", 0, true);
  c2.receive('{"type":"result","subtype":"success","is_error":true,"result":"You\'ve hit your session limit · resets in 1 second"}');
  ok("a short limit is retried automatically, no question asked", await until(() => app2.host.screen.message.peek().startsWith("retrying in ")) && c2.model.openRequests().length === 0);
  const answer = app2.js.answer("agent.send", JSON.stringify(["the task finished", { from: "task" }]));
  const sent = JSON.parse(answer.text) as { error: string };
  eq("a send from a task is accepted", sent.error, "");
  eq("and does not fire messageSending", String(sending), "0");
  ok("and the retry stays scheduled", app2.host.screen.message.peek().startsWith("retrying in "));
  ok("the retry fires on its own and resends the user's message", await until(() => written.length > 0 && promptOf(written[written.length - 1]) === "the user's message", 12000));
  closeWidecode(app2);
  rmSync(folder2, { recursive: true, force: true });

  // The windows are the agent's: Claude Code's are not another agent's.
  const home = mkdtempSync(join(tmpdir(), "widecode-limits-home-"));
  const store = new Store(home);
  const claude = new Limits();
  claude.fiveHour.usedPercent = 99;
  claude.fiveHour.resetsAt = now + 3600;
  store.saveLimits(claude, "claude");
  await app.host.session.useStore(store);
  eq("Claude's limit shows for Claude", String(c.info.fiveHourPct), "99");
  eq("another agent has its own (none yet)", app.host.session.useAgent("opencode") + " " + String(c.info.fiveHourPct), " -1");
  eq("and Claude's come back with Claude", app.host.session.useAgent("claude") + " " + String(c.info.fiveHourPct), " 99");
  rmSync(home, { recursive: true, force: true });

  closeWidecode(app);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exitCode = 1;
});
