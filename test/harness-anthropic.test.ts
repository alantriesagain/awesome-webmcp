// The Anthropic Messages API as text: a request's body for a model with adaptive thinking and
// Anthropic's extras (the system blocks with the breakpoint on the last, the tools with eager
// input streaming and the breakpoint on the last, the messages with every kind of part, the last
// user block cached, the effort), for DeepSeek without the extras and with a budget, for Haiku
// with a budget by effort; the stream's events read into parts, a tool call's input, the usage
// and the stop reason; a refusal and an error.
import { AnthropicReader, messagesJson, requestBody } from "../src/harness/model/anthropic.ts";
import { ModelRequest, StreamListener } from "../src/harness/model/client.ts";
import { IMAGE, Message, Part, THINKING, TOOL_CALL, TOOL_RESULT, textPart } from "../src/harness/model/message.ts";
import { ModelRegistry } from "../src/harness/model/registry.ts";
import { SseEvent, SseSplitter } from "../src/harness/model/sse.ts";
import { readFileSync } from "node:fs";
import { ToolSet, builtInTools } from "../src/harness/tools/tool.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const r = ModelRegistry.builtIn();
const user = new Message("user", "u1");
user.parts.push(textPart("Read it"));
const image = new Part(IMAGE);
image.mediaType = "image/png";
image.data = "AAAA";
user.parts.push(image);
const assistant = new Message("assistant", "m1");
const thought = new Part(THINKING);
thought.text = "Let me see.";
thought.signature = "sig";
assistant.parts.push(thought);
assistant.parts.push(textPart("Reading."));
const call = new Part(TOOL_CALL);
call.callId = "toolu_1";
call.name = "Read";
call.inputJson = '{"file_path":"a.txt"}';
assistant.parts.push(call);
const results = new Message("user", "u2");
const result = new Part(TOOL_RESULT);
result.callId = "toolu_1";
result.text = "1\tone";
results.parts.push(result);
const empty = textPart("");
results.parts.push(empty);

const req = new ModelRequest("anthropic/claude-opus-5", ["Base.", "Project."], [user, assistant, results]);
req.effort = "xhigh";
req.toolsJson = new ToolSet(builtInTools()).json(true);
const opus = r.model("anthropic/claude-opus-5");
const anthropic = r.provider("anthropic");
if (opus === null || anthropic === null) throw new Error("no opus");
const body = requestBody(req, opus, anthropic);
ok("the model, the output cap, the stream", body.startsWith('{"model":"claude-opus-5","max_tokens":64000,"stream":true,'));
ok("the system blocks, the breakpoint on the last", body.includes('"system":[{"type":"text","text":"Base."},{"type":"text","text":"Project.","cache_control":{"type":"ephemeral"}}]'));
ok("the tools with eager input streaming, the breakpoint on the last", body.includes('"tools":[{"name":"Read",') && body.includes('"eager_input_streaming":true}') && body.includes('"eager_input_streaming":true,"cache_control":{"type":"ephemeral"}}]'));
eq("the messages: text and image, thinking with its signature, text, the call with its input, the result cached as the last user block, the empty text left out", messagesJson(req.messages, true), '[{"role":"user","content":[{"type":"text","text":"Read it"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]},{"role":"assistant","content":[{"type":"thinking","thinking":"Let me see.","signature":"sig"},{"type":"text","text":"Reading."},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"a.txt"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"1\\tone","cache_control":{"type":"ephemeral"}}]}]');
ok("adaptive thinking shown, and the effort", body.endsWith(',"thinking":{"type":"adaptive","display":"summarized"},"output_config":{"effort":"xhigh"}}'));

const deepseek = r.provider("deepseek");
const pro = r.model("deepseek/deepseek-v4-pro");
if (deepseek === null || pro === null) throw new Error("no deepseek");
const req2 = new ModelRequest("deepseek/deepseek-v4-pro", ["Base."], [user]);
req2.effort = "high";
req2.toolsJson = new ToolSet(builtInTools()).json(false);
const body2 = requestBody(req2, pro, deepseek);
ok("DeepSeek: no breakpoints, no eager streaming, a thinking budget, no effort", !body2.includes("cache_control") && !body2.includes("eager_input_streaming") && body2.endsWith(',"thinking":{"type":"enabled","budget_tokens":16384}}') && !body2.includes("output_config"));
const haiku = r.model("anthropic/claude-haiku-4-5");
if (haiku === null) throw new Error("no haiku");
const req3 = new ModelRequest("anthropic/claude-haiku-4-5", [], [user]);
req3.effort = "off";
ok("Haiku with thinking off: no thinking at all", !requestBody(req3, haiku, anthropic).includes("thinking"));
req3.effort = "low";
ok("Haiku at low: a small budget", requestBody(req3, haiku, anthropic).includes('"thinking":{"type":"enabled","budget_tokens":2048}'));

// The stream read.
const heard: string[] = [];
const l = new StreamListener();
l.onText = (d) => heard.push("text:" + d);
l.onThinking = (d) => heard.push("think:" + d);
l.onSignature = (d) => heard.push("sig:" + d);
l.onToolCallStart = (id, name) => heard.push("call:" + id + ":" + name);
l.onToolCallDelta = (id, json) => heard.push("json:" + id + ":" + json);
l.onToolCallEnd = (id) => heard.push("end:" + id);
const reader = new AnthropicReader(l);
const ev = (event: string, data: string): SseEvent => new SseEvent(event, data);
reader.take(ev("message_start", '{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":120,"cache_creation_input_tokens":30,"cache_read_input_tokens":500,"output_tokens":1}}}'));
reader.take(ev("content_block_start", '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}'));
reader.take(ev("content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Hmm."}}'));
reader.take(ev("content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}'));
reader.take(ev("content_block_stop", '{"type":"content_block_stop","index":0}'));
reader.take(ev("content_block_start", '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}'));
reader.take(ev("content_block_delta", '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"I will read it."}}'));
reader.take(ev("content_block_stop", '{"type":"content_block_stop","index":1}'));
reader.take(ev("content_block_start", '{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_9","name":"Read","input":{}}}'));
reader.take(ev("content_block_delta", '{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"file_pa"}}'));
reader.take(ev("content_block_delta", '{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"th\\":\\"a.txt\\"}"}}'));
reader.take(ev("content_block_stop", '{"type":"content_block_stop","index":2}'));
reader.take(ev("ping", '{"type":"ping"}'));
reader.take(ev("message_delta", '{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":42}}'));
reader.take(ev("message_stop", '{"type":"message_stop"}'));
eq("thinking with its signature, text, a tool call with its input in pieces", heard.join(" "), 'think:Hmm. sig:abc text:I will read it. call:toolu_9:Read json:toolu_9:{"file_pa json:toolu_9:th":"a.txt"} end:toolu_9');
eq("the stop reason and the usage", reader.end.stopReason + " " + String(reader.end.usage.input) + "/" + String(reader.end.usage.output) + "/" + String(reader.end.usage.cacheRead) + "/" + String(reader.end.usage.cacheWrite) + " " + String(reader.stopped), "tool_use 120/42/500/30 true");
const zen = new AnthropicReader(new StreamListener());
zen.take(ev("message_delta", '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":166,"cache_read_input_tokens":5902,"cost":0.00015302}}'));
eq("the cost a provider reports (OpenCode Zen's)", String(zen.end.usage.reportedCost) + " " + String(reader.end.usage.reportedCost), "0.00015302 -1");

const refused = new AnthropicReader(new StreamListener());
refused.take(ev("message_delta", '{"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber"}},"usage":{"output_tokens":0}}'));
eq("a refusal fails the stream with its category", refused.end.stopReason + " " + refused.end.error, "error the model refused (cyber)");
// A stream DeepSeek served through its Anthropic-format endpoint, recorded by test/probe/model.mjs.
const recorded: string[] = [];
const rl = new StreamListener();
rl.onToolCallStart = (_id, name) => recorded.push("call " + name);
rl.onToolCallDelta = (_id, json) => recorded.push(json);
rl.onSignature = (d) => recorded.push("sig " + String(d.length > 0));
const rr = new AnthropicReader(rl);
const rs = new SseSplitter();
for (const e of rs.push(readFileSync("test/harness/fixtures/model-deepseek-tools.sse", "utf8"))) rr.take(e);
for (const e of rs.flush()) rr.take(e);
eq("DeepSeek's recorded stream: a thinking signature, a Bash call with its input in pieces, the stop reason and usage", recorded.filter((r) => r.startsWith("sig") || r.startsWith("call")).join(" ") + " " + recorded.filter((r) => !r.startsWith("sig") && !r.startsWith("call")).join("") + " " + rr.end.stopReason + " " + String(rr.end.usage.input) + "/" + String(rr.end.usage.output), 'sig true call Bash {"command": "echo PONG"} tool_use 331/40');
const errored = new AnthropicReader(new StreamListener());
errored.take(ev("error", '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'));
eq("an error event fails it with the message", errored.end.stopReason + " " + errored.end.error, "error overloaded_error: Overloaded");
done();
