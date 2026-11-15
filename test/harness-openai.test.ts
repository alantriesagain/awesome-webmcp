// The chat completions client: the conversation as chat messages (the system prompt joined, tool
// results as tool messages before the user's words, an image as a data address, the assistant's
// thinking sent back under the model's field with its tool calls); the request by thinking kind;
// a stream read into the listener (thinking, text, tool calls whose id and name come in their
// first chunk or later, arguments in pieces, the usage with its cached share, the finish reasons,
// an error chunk); then the client against the fake server: the path, the bearer key, a 429 tried
// again, a 401's message; and OpenCode Zen's models in the registry, each on its endpoint.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../src/harness/auth.ts";
import { Abort } from "../src/harness/loop/abort.ts";
import { ModelRequest, StreamListener } from "../src/harness/model/client.ts";
import { IMAGE, Message, Part, THINKING, TOOL_CALL, TOOL_RESULT, textPart } from "../src/harness/model/message.ts";
import { ChatReader, OpenAiClient, chatMessagesJson, chatRequestBody } from "../src/harness/model/openai.ts";
import { EFFORT, ModelInfo, ModelRegistry, NO_THINKING, OPENAI_API, Provider, TOGGLE } from "../src/harness/model/registry.ts";
import { SseSplitter } from "../src/harness/model/sse.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const user = new Message("user", "u1");
user.parts.push(textPart("list the files"));
const assistant = new Message("assistant", "m1");
const thought = new Part(THINKING);
thought.text = "I should run ls.";
const call = new Part(TOOL_CALL);
call.callId = "call_a";
call.name = "Bash";
call.inputJson = '{"command":"ls"}';
assistant.parts.push(thought, textPart("Listing."), call);
const results = new Message("user", "u2");
const r = new Part(TOOL_RESULT);
r.callId = "call_a";
r.text = "a.txt";
const img = new Part(IMAGE);
img.mediaType = "image/png";
img.data = "AAAA";
results.parts.push(r, textPart("and this picture"), img);
const bare = new Message("assistant", "m2");
const lone = new Part(TOOL_CALL);
lone.callId = "call_b";
lone.name = "Read";
bare.parts.push(lone);

eq(
  "the messages: the system joined, the assistant's thinking and calls, the results as tool messages, then the user's words and image",
  chatMessagesJson(["You are terse.", "The folder: /p"], [user, assistant, results, bare], "reasoning_content"),
  '[{"role":"system","content":"You are terse.\\n\\nThe folder: /p"},{"role":"user","content":"list the files"},{"role":"assistant","content":"Listing.","reasoning_content":"I should run ls.","tool_calls":[{"id":"call_a","type":"function","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}]},{"role":"tool","tool_call_id":"call_a","content":"a.txt"},{"role":"user","content":[{"type":"text","text":"and this picture"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]},{"role":"assistant","content":null,"tool_calls":[{"id":"call_b","type":"function","function":{"name":"Read","arguments":"{}"}}]}]',
);
eq("no reasoning field: the thinking stays home", String(chatMessagesJson([], [assistant], "").includes("reasoning")), "false");

const m = new ModelInfo("p", "model-x", "X");
m.maxOutput = 1000;
const req = new ModelRequest("p/model-x", [], [user]);
req.toolsOpenAiJson = '[{"type":"function","function":{"name":"Bash","description":"Run","parameters":{"type":"object"}}}]';
eq("the request: streamed with its usage, the tools", chatRequestBody(req, m), '{"model":"model-x","stream":true,"stream_options":{"include_usage":true},"max_tokens":1000,"messages":[{"role":"user","content":"list the files"}],"tools":[{"type":"function","function":{"name":"Bash","description":"Run","parameters":{"type":"object"}}}]}');
m.thinking = TOGGLE;
m.efforts = ["on", "off"];
req.effort = "off";
ok("thinking toggled off", chatRequestBody(req, m).endsWith(',"thinking":{"type":"disabled"}}'));
req.effort = "on";
ok("and on", chatRequestBody(req, m).endsWith(',"thinking":{"type":"enabled"}}'));
m.thinking = EFFORT;
m.efforts = ["low", "medium", "high"];
req.effort = "low";
ok("an effort", chatRequestBody(req, m).endsWith(',"reasoning_effort":"low"}'));
m.thinking = NO_THINKING;
ok("none", !chatRequestBody(req, m).includes("thinking") && !chatRequestBody(req, m).includes("reasoning_effort"));

/** The listener's events as text. */
const record = (): { listener: StreamListener; events: string[] } => {
  const events: string[] = [];
  const l = new StreamListener();
  l.onThinking = (d: string) => events.push("think:" + d);
  l.onText = (d: string) => events.push("text:" + d);
  l.onToolCallStart = (id: string, name: string) => events.push("start:" + id + ":" + name);
  l.onToolCallDelta = (id: string, json: string) => events.push("args:" + id + ":" + json);
  l.onToolCallEnd = (id: string) => events.push("end:" + id);
  return { listener: l, events };
};
const chunk = (delta: unknown, finish: string): string => "data: " + JSON.stringify({ id: "c", choices: [{ index: 0, delta, finish_reason: finish.length > 0 ? finish : null }] }) + "\n\n";
const stream =
  chunk({ role: "assistant", reasoning_content: "Think" }, "") +
  chunk({ reasoning_content: "ing." }, "") +
  chunk({ content: "Running " }, "") +
  chunk({ content: "it." }, "") +
  chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Bash", arguments: "" } }] }, "") +
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] }, "") +
  chunk({ tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }, "") +
  chunk({ tool_calls: [{ index: 1, function: { arguments: '{"file_path":' } }] }, "") +
  chunk({ tool_calls: [{ index: 1, id: "call_2", function: { name: "Read", arguments: '"a.txt"}' } }] }, "") +
  chunk({}, "tool_calls") +
  "data: " + JSON.stringify({ id: "c", choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20 } }) + "\n\n" +
  "data: [DONE]\n\n";
const read = (text: string): { events: string[]; reader: ChatReader } => {
  const rec = record();
  const reader = new ChatReader(rec.listener);
  const sse = new SseSplitter();
  for (const ev of sse.push(text)) reader.take(ev);
  for (const ev of sse.flush()) reader.take(ev);
  reader.close();
  return { events: rec.events, reader };
};
const got = read(stream);
eq(
  "the stream: thinking, text, a call with its arguments in pieces, one whose name came after its first arguments",
  got.events.join(" | "),
  'think:Think | think:ing. | text:Running  | text:it. | start:call_1:Bash | args:call_1:{"comm | args:call_1:and":"ls"} | start:call_2:Read | args:call_2:{"file_path": | args:call_2:"a.txt"} | end:call_1 | end:call_2',
);
eq("the end: tool use, the input without the cached share, the cached share, the output", got.reader.end.stopReason + " " + String(got.reader.end.usage.input) + " " + String(got.reader.end.usage.cacheRead) + " " + String(got.reader.end.usage.output) + " " + String(got.reader.done), "tool_use 20 100 30 true");
const openai = read(chunk({ content: "Hi" }, "stop") + "data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 40 } } }) + "\n\ndata: [DONE]\n\n");
eq("OpenAI's cached share; a stop", openai.reader.end.stopReason + " " + String(openai.reader.end.usage.input) + " " + String(openai.reader.end.usage.cacheRead), "end_turn 10 40");
const billed = read(chunk({ content: "Hi" }, "stop") + "data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: 3820, completion_tokens: 142, prompt_tokens_details: { cached_tokens: 3712 }, cost: 0.00022507 } }) + "\n\ndata: [DONE]\n\n");
eq("the cost a provider reports (OpenCode Zen's), and none when it says nothing", String(billed.reader.end.usage.reportedCost) + " " + String(openai.reader.end.usage.reportedCost), "0.00022507 -1");
eq("cut at the length", read(chunk({ content: "Hi" }, "length")).reader.end.stopReason, "max_tokens");
eq("the content filter", read(chunk({}, "content_filter")).reader.end.error, "the provider's content filter stopped the reply");
eq("an error chunk", read('data: {"error":{"type":"overloaded","message":"busy now"}}\n\n').reader.end.stopReason + " " + read('data: {"error":{"message":"busy now"}}\n\n').reader.end.error, "error busy now");
eq("OpenRouter's `reasoning` field", read(chunk({ reasoning: "Hmm." }, "stop")).events.join(""), "think:Hmm.");

const startServer = (fixture: string, log: string): Promise<{ child: ChildProcess; port: number }> =>
  new Promise((settle, reject) => {
    const child = spawn("node", [join(process.cwd(), "test", "harness", "fake-model.mjs"), "--fixture", fixture, "--log", log], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout!.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      const mm = /PORT (\d+)/.exec(out);
      if (mm !== null) settle({ child, port: Number(mm[1]) });
    });
    child.on("error", (e: Error) => reject(e));
  });

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "harness-openai-"));
  const fixture = join(folder, "fixture.jsonl");
  const log = join(folder, "requests.log");
  const sse = (text: string): string => JSON.stringify({ status: 200, sse: text.trim() });
  writeFileSync(
    fixture,
    [
      sse(chunk({ content: "Hello " }, "") + chunk({ content: "there." }, "stop") + "data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }) + "\n\ndata: [DONE]"),
      JSON.stringify({ status: 429, body: '{"error":{"message":"slow down"}}' }),
      sse(chunk({ content: "After a retry." }, "stop") + "data: [DONE]"),
      JSON.stringify({ status: 401, body: '{"error":{"message":"Invalid API key","type":"authentication_error"}}' }),
    ].join("\n") + "\n",
  );
  const server = await startServer(fixture, log);
  const registry = new ModelRegistry();
  const p = new Provider("local", "Local", "http://127.0.0.1:" + String(server.port) + "/v1/", "HARNESS_OPENAI_TEST_KEY", false);
  p.api = OPENAI_API;
  registry.providers.push(p);
  const model = new ModelInfo("local", "small", "Small");
  model.maxOutput = 500;
  registry.models.push(model);
  process.env["HARNESS_OPENAI_TEST_KEY"] = "sk-local";
  const client = new OpenAiClient(registry, new Auth(join(folder, "auth.json")), "node");
  const text: string[] = [];
  const l = new StreamListener();
  l.onText = (d: string) => text.push(d);
  const end = await client.stream(new ModelRequest("local/small", ["Be brief."], [user]), l, new Abort());
  eq("a reply from the server", text.join("") + " | " + end.stopReason + " " + String(end.usage.input) + " " + String(end.usage.output), "Hello there. | end_turn 9 2");
  const sent = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { url: string; headers: Record<string, string>; body: string });
  eq("to chat/completions under the base, with the key as a bearer", sent[0].url + " " + sent[0].headers["authorization"] + " " + String(sent[0].body.startsWith('{"model":"small","stream":true')), "/v1/chat/completions Bearer sk-local true");
  text.length = 0;
  const retried = await client.stream(new ModelRequest("local/small", [], [user]), l, new Abort());
  eq("a 429 tried again", text.join("") + " " + retried.stopReason, "After a retry. end_turn");
  const refused = await client.stream(new ModelRequest("local/small", [], [user]), l, new Abort());
  eq("a 401's message", refused.stopReason + " " + refused.error, "error authentication_error: Invalid API key");
  delete process.env["HARNESS_OPENAI_TEST_KEY"];
  const nokey = await client.stream(new ModelRequest("local/small", [], [user]), l, new Abort());
  eq("no key", nokey.error, "no key for Local: set HARNESS_OPENAI_TEST_KEY or run widecode --harness-auth local");
  server.child.stdin!.end();
  server.child.kill();

  const built = ModelRegistry.builtIn();
  const zen = built.models.filter((x) => x.provider === "opencode");
  eq("OpenCode Zen's models, each on its endpoint", zen.map((x) => x.id + "=" + built.apiOf(x)).join(" "), "claude-haiku-5-5=anthropic claude-sonnet-5-5=anthropic claude-opus-5-5=anthropic claude-fable-5-1=anthropic qwen3.8-flash=anthropic qwen3.6-plus=anthropic deepseek-v4.1-flash=openai deepseek-v4-pro=openai glm-5.3-flash=openai glm-5.3=openai minimax-m3=openai kimi-k3=openai");
  eq("Anthropic's extras on Zen's Anthropic endpoint alone, by the model's say", zen.map((x) => (built.extrasOf(x) ? "on" : "off")).join(","), "on,on,on,on,on,on,off,off,off,off,off,off");
  const claude = built.model("opencode/claude-sonnet-5-5");
  const ds = built.model("opencode/deepseek-v4.1-flash");
  eq("Claude's base and DeepSeek's provider base, the key's variable", (claude !== null ? claude.baseUrl : "") + " " + (built.provider("opencode")?.baseUrl ?? "") + " " + (built.provider("opencode")?.keyEnv ?? "") + " " + (ds !== null ? ds.efforts.join("/") : ""), "https://opencode.ai/inference/anthropic https://opencode.ai/inference/openai/v1 OPENCODE_API_KEY on/off");
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
