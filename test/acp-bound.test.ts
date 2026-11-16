// ffi: @lightstart/plugins/native/ffi.json
// The acp plugin bounds what it keeps: a long tool output reaches the conversation cut to a preview
// with its full size and who cut it (widecode, or the agent when its raw output says so), a
// repeated raw input sends one input event, and a whole written file is cut the same way.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Item } from "../src/conversation/model.ts";
import type { Widecode } from "../src/compose.ts";
import { Store } from "../src/services/store.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";

const fake = join(process.cwd(), "test/fake-acp.mjs");

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

const pieces = (item: Item | null): { text: string; size?: number; truncated?: string } | null =>
  item !== null && item.result !== null ? (item.result as unknown as { text: string; size?: number; truncated?: string }) : null;

/** The events a Task run kept, by the line each was written as. */
const transcript = (folder: string, session: string, call: string): Record<string, unknown>[] => {
  const path = join(folder, ".widecode", "tasks", session.replace(/[^A-Za-z0-9_.-]/g, "_"), call + ".jsonl");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-acp-bound-"));
  const home = mkdtempSync(join(tmpdir(), "widecode-acp-bound-home-"));
  const log = join(folder, "fake.log");
  const w = await openWidecode({
    folder,
    plugins: { acp: { agents: { fake: { name: "Fake", command: ["node", fake, "--log", log] } }, tasks: { targets: { deepseek: { agent: "fake" } }, maxConcurrent: 2 } } },
    load: true,
    before: async (w: Widecode) => {
      const store = new Store(home);
      store.trust(folder);
      await w.host.useStore(store);
      w.host.session.agentId.value = "fake";
    },
  });
  const c = w.host.conversation;
  c.prepare();
  const url = await w.js.mcp.start();
  const token = w.js.mcp.tokenFor("acp");
  const post = (body: string): Promise<string> => send(url, token, body);

  // The main session's result is a preview: its first 48,000, the number cut, its last 16,000.
  w.host.roles.chat.submit("big");
  ok("the big turn ends", await until(() => !c.model.running && c.model.tool("call_big") !== null && c.model.tool("call_big")?.result !== null, 15000));
  const big = pieces(c.model.tool("call_big"));
  const marker = "[… 136000 characters cut by widecode …]";
  eq("its text is the first 48,000, the cut's line, the last 16,000", big !== null ? String(big.text.length) + " " + String(big.text.startsWith("x".repeat(48000))) + " " + String(big.text.includes(marker)) + " " + String(big.text.endsWith("x".repeat(16000))) : "none", "64041 true true true");
  eq("its result keeps the full size and who cut it", big !== null ? String(big.size) + " " + String(big.truncated) : "none", "200000 widecode");

  // A Task run keeps the same preview, with the full size and who cut it.
  c.model.openTurn("main", 0, true);
  const bigReply = await post('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"Task","arguments":{"description":"a long output","prompt":"big","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-bound-big"}}}');
  ok("the Task run answers", bigReply.includes("Printed a lot."));
  c.model.closeTurn(null);
  const bigEvents = transcript(folder, c.model.sessionId, "toolu-bound-big");
  const bigResult = bigEvents.find((e) => e.type === "result" && String(e.id).endsWith("call:call_big")) ?? null;
  eq("the kept result carries the full size and widecode's cut", bigResult !== null ? String(bigResult.size) + " " + String(bigResult.truncated) : "none", "200000 widecode");
  ok("and the preview is the same", bigResult !== null && String(bigResult.text).startsWith("x".repeat(48000)) && String(bigResult.text).includes(marker) && String(bigResult.text).endsWith("x".repeat(16000)));

  // An agent that says it cut its own output is marked as the one who cut it.
  c.model.openTurn("main", 0, true);
  const agentReply = await post('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"Task","arguments":{"description":"an agent cut","prompt":"bigagent","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-bound-agent"}}}');
  ok("the agent-cut Task run answers", agentReply.includes("Printed a lot."));
  c.model.closeTurn(null);
  const agentResult = transcript(folder, c.model.sessionId, "toolu-bound-agent").find((e) => e.type === "result" && String(e.id).endsWith("call:call_big")) ?? null;
  eq("the result says the agent cut it", agentResult !== null ? String(agentResult.text) + " " + String(agentResult.truncated) : "none", "the agent cut this\n agent");

  // The same input sent again emits one input event, and the call's input is dropped when it ends.
  c.model.openTurn("main", 0, true);
  const repeatReply = await post('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"Task","arguments":{"description":"the same input","prompt":"repeatinput","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-bound-repeat"}}}');
  ok("the repeated-input Task run answers", repeatReply.includes("Same again."));
  c.model.closeTurn(null);
  const repeatEvents = transcript(folder, c.model.sessionId, "toolu-bound-repeat");
  const inputs = repeatEvents.filter((e) => e.type === "input" && String(e.key).endsWith("call_repeat"));
  eq("one input event for the repeated raw input", String(inputs.length), "1");

  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exitCode = 1;
});
