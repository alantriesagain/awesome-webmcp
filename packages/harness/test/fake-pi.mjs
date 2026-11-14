// A fake pi in its RPC mode: reads JSONL commands on stdin, writes the records a run of the live
// transcript carries (a write call that makes answer.txt, then a one-word reply), and answers
// get_session_stats with the run's cost. Driven by bench.test.ts through the pi driver.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const out = (r) => process.stdout.write(JSON.stringify(r) + "\n");
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost };
const usage = (input, output, cacheRead, total) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: input + output + cacheRead,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
const u1 = usage(30, 10, 20, 0.001);
const u2 = usage(100, 5, 50, 0.0005);
const toolCall = { type: "toolCall", id: "call_1", name: "write", arguments: { path: "answer.txt", content: "8443\n" } };
const assistant = (content, usageValue, stopReason) => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "opencode",
  model: "deepseek-v4.1-flash",
  usage: usageValue,
  stopReason,
  timestamp: Date.now(),
});

const prompt = (command) => {
  out({ id: command.id ?? "p1", type: "response", command: "prompt", success: true, data: { disposition: "started" } });
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "message_start", message: { role: "user", content: [{ type: "text", text: command.message ?? "" }], timestamp: Date.now() } });
  out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: command.message ?? "" }], timestamp: Date.now() } });
  out({ type: "message_start", message: { role: "assistant", content: [], usage: zeroUsage, stopReason: "pending", timestamp: Date.now() } });
  out({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "write" } });
  out({ type: "message_update", usage: u1, assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall } });
  out({ type: "message_end", message: assistant([toolCall], u1, "toolUse") });
  out({ type: "tool_execution_start", toolCallId: "call_1", toolName: "write", args: { path: "answer.txt", content: "8443\n" } });
  writeFileSync(join(process.cwd(), "answer.txt"), "8443\n");
  out({ type: "tool_execution_end", toolCallId: "call_1", toolName: "write", result: { content: [{ type: "text", text: "Successfully wrote to answer.txt" }] }, isError: false, durationMs: 1 });
  out({ type: "turn_end", message: assistant([toolCall], u1, "toolUse"), toolResults: [] });
  out({ type: "turn_start" });
  out({ type: "message_start", message: { role: "assistant", content: [], usage: zeroUsage, stopReason: "pending", timestamp: Date.now() } });
  out({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  out({ type: "message_update", usage: u2, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" } });
  out({ type: "message_update", usage: u2, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "done" } });
  out({ type: "message_end", message: assistant([{ type: "text", text: "done" }], u2, "stop") });
  out({ type: "turn_end", message: assistant([{ type: "text", text: "done" }], u2, "stop"), toolResults: [] });
  out({ type: "agent_end", messages: [], willRetry: false });
  out({ type: "agent_settled", aborted: false });
};

const handle = (command) => {
  const type = command.type;
  if (type === "prompt") prompt(command);
  else if (type === "abort") out({ id: command.id ?? "a", type: "response", command: "abort", success: true });
  else if (type === "get_session_stats") {
    out({
      id: command.id ?? "s",
      type: "response",
      command: "get_session_stats",
      success: true,
      data: {
        userMessages: 1,
        assistantMessages: 2,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 5,
        tokens: { input: 180, output: 15, cacheRead: 70, cacheWrite: 0, total: 265 },
        cost: 0.0015,
        contextUsage: { tokens: 155, contextWindow: 1000000, percent: 0.0155 },
      },
    });
  }
};

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    let line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim().length === 0) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // A malformed command is not this fake's business.
    }
  }
});
process.stdin.on("end", () => process.exit(0));
