#!/usr/bin/env node
/**
 * @file Records a real provider's streams for the harness's goldens, on its cheapest model: a
 * turn with a Bash tool call ("run echo PONG"), then the tool's result answered. Runs only when
 * asked (`NATIVE_LIVE=1`) with the provider's key in the environment. Writes
 * `test/fixtures/model-<provider>-tools.sse` (the first request's events) and
 * `model-<provider>-result.sse` (the second's), plus the request bodies beside them.
 *
 * Usage: NATIVE_LIVE=1 node test/probe/model.mjs [anthropic|deepseek]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.env.NATIVE_LIVE !== "1") {
  console.error("set NATIVE_LIVE=1 to spend a few cents on a real model");
  process.exit(2);
}
const provider = process.argv[2] ?? "deepseek";
const PROVIDERS = {
  anthropic: { url: "https://api.anthropic.com/v1/messages", key: "ANTHROPIC_API_KEY", model: "claude-haiku-4-5", thinking: { type: "enabled", budget_tokens: 2048 }, extras: true },
  deepseek: { url: "https://api.deepseek.com/anthropic/v1/messages", key: "DEEPSEEK_API_KEY", model: "deepseek-flash", thinking: { type: "enabled", budget_tokens: 2048 }, extras: false },
};
const p = PROVIDERS[provider];
if (p === undefined) {
  console.error("unknown provider " + provider + "; one of " + Object.keys(PROVIDERS).join(", "));
  process.exit(2);
}
const key = process.env[p.key] ?? "";
if (key.length === 0) {
  console.error("set " + p.key);
  process.exit(2);
}
const tool = { name: "Bash", description: "Run a shell command and get its output.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
if (p.extras) tool.eager_input_streaming = true;
const fixtures = join(process.cwd(), "test", "fixtures");

const stream = async (name, messages) => {
  const body = { model: p.model, max_tokens: 2000, stream: true, system: "You are a terse assistant. Use the Bash tool when asked to run a command.", tools: [tool], messages, thinking: p.thinking };
  const res = await fetch(p.url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
  const text = await res.text();
  writeFileSync(join(fixtures, "model-" + provider + "-" + name + ".request.json"), JSON.stringify(body, null, 2) + "\n");
  writeFileSync(join(fixtures, "model-" + provider + "-" + name + ".sse"), text);
  console.log(name + ": HTTP " + res.status + ", " + text.length + " bytes");
  if (res.status !== 200) {
    console.error(text);
    process.exit(1);
  }
  // The content blocks, from the events, for the next request.
  const blocks = [];
  let json = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const d = JSON.parse(line.slice(6));
    if (d.type === "content_block_start") {
      blocks.push({ ...d.content_block });
      json = "";
    } else if (d.type === "content_block_delta") {
      const b = blocks[blocks.length - 1];
      if (d.delta.type === "text_delta") b.text = (b.text ?? "") + d.delta.text;
      else if (d.delta.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.delta.thinking;
      else if (d.delta.type === "signature_delta") b.signature = (b.signature ?? "") + d.delta.signature;
      else if (d.delta.type === "input_json_delta") json += d.delta.partial_json;
    } else if (d.type === "content_block_stop") {
      const b = blocks[blocks.length - 1];
      if (b.type === "tool_use") b.input = JSON.parse(json.length > 0 ? json : "{}");
    }
  }
  return blocks;
};

const first = [{ role: "user", content: "Run `echo PONG` with the Bash tool and tell me what it printed, in five words or fewer." }];
const blocks = await stream("tools", first);
const call = blocks.find((b) => b.type === "tool_use");
if (call === undefined) {
  console.error("no tool call in the first reply");
  process.exit(1);
}
const assistant = blocks.filter((b) => b.type !== "thinking" || (b.signature ?? "").length > 0);
await stream("result", [...first, { role: "assistant", content: assistant }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "PONG\n" }] }]);
console.log("recorded under " + fixtures);
