// The agent over a sink server and the fake model: initialize's capabilities; a session with its
// options (the models by provider, the model's efforts, the modes), commands and usage; a prompt
// streamed as chunks and answered with the stop reason and usage; `_meta.widecode` kept and put
// in the system prompt; a prompt sent mid-turn steering the turn and answered with it; a tool
// call announced, run and ended, its result read by the next request; a cancel answering
// `cancelled`; an option set, a mode's update, plan mode's tools; a fork carrying the messages;
// an unknown method and session refused.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAgent } from "../acp/agent.ts";
import { AcpServer, Incoming } from "../acp/server.ts";
import { Auth } from "../auth.ts";
import { registryFor } from "../cli.ts";
import { HarnessConfig } from "../config.ts";
import { ModelClient } from "../model/client.ts";
import { FakeClient } from "../model/fake.ts";
import { ToolSet, builtInTools } from "../tools/tool.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const FIXTURE = [
  '{"match":"hello","text":"Hello, world.","thinking":"Thinking about it.","input":12,"output":4}',
  '{"match":"slow","text":"Working on it for a while now.","chunks":4,"delayMs":40}',
  '{"match":"run","text":"Running it.","tools":[{"name":"Bash","input":{"command":"echo hi; echo there"}},{"name":"Read","input":{"file_path":"a.txt"}}]}',
  '{"match":"result","text":"It said hi."}',
  '{"match":"hold","text":"Holding","hold":true}',
  '{"match":"fail","error":"model unavailable"}',
].join("\n");

const until = (what: () => boolean): Promise<void> =>
  new Promise<void>((settle) => {
    const tick = (): void => {
      if (what()) settle();
      else setTimeout(tick, 10);
    };
    tick();
  });

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "harness-agent-"));
  writeFileSync(join(folder, "a.txt"), "one\ntwo\n");
  const server = new AcpServer();
  const out: string[] = [];
  server.sink = (line: string) => out.push(line);
  const config = new HarnessConfig();
  const registry = registryFor(config, true);
  const agent = new AcpAgent(server, new ModelClient(registry, new Auth(join(folder, "auth.json")), "node", FakeClient.fromText(FIXTURE)), new ToolSet(builtInTools()), registry, config, "test", "linux");
  let n = 0;
  const send = (method: string, params: unknown, notification = false): string => {
    const id = notification ? "" : String(++n);
    agent.receive(new Incoming(method, params, id));
    return id;
  };
  /** The lines since the last call, the sessionId's text folded. */
  const taken = (): string[] => out.splice(0, out.length);

  send("initialize", { protocolVersion: 1 });
  ok("initialize: the capabilities the client reads", taken()[0].includes('"agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true},"promptCapabilities":{"image":true},"sessionCapabilities":{"list":{},"fork":{}}}'));

  send("session/new", { cwd: folder, mcpServers: [{ type: "http", name: "widecode", url: "http://127.0.0.1:1/mcp" }], _meta: { widecode: { systemPrompt: "Be terse.", trusted: true } } });
  const made = taken();
  const sid = /"sessionId":"([^"]+)"/.exec(made[0])?.[1] ?? "";
  ok("a session with its id", sid.startsWith("h-"));
  ok("and its options: the models grouped by provider, the fake first, Anthropic's and DeepSeek's after", made[0].includes('"configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"fake/fake","options":[{"group":"Fake","name":"Fake","options":[{"value":"fake/fake","name":"Fake"}]},{"group":"Anthropic","name":"Anthropic","options":[{"value":"anthropic/claude-opus-5","name":"Claude Opus 5"}') && made[0].includes('{"value":"deepseek/deepseek-v4-pro","name":"DeepSeek V4 Pro"}'));
  ok("the model's efforts and the modes", made[0].includes('{"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"low","name":"low"},{"value":"medium","name":"medium"},{"value":"high","name":"high"}]},{"id":"mode","name":"Mode","category":"mode","type":"select","currentValue":"build","options":[{"value":"build","name":"Build"},{"value":"plan","name":"Plan"}]}]'));
  ok("then the commands and the usage", made[1].includes('"availableCommands":[{"name":"compact"') && made[2].includes('"sessionUpdate":"usage_update","used":0,"size":200000}'));

  const first = send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "hello there" }] });
  await until(() => out.some((l) => l.includes('"id":' + first)));
  const turn = taken();
  eq("the thought, the text in chunks, the usage, then the answer", turn.map((l) => (l.includes("agent_thought_chunk") ? "thought" : l.includes("agent_message_chunk") ? "chunk" : l.includes("usage_update") ? "usage" : l.includes('"result"') ? "answer" : "?")).join(","), "thought,chunk,chunk,usage,answer");
  ok("the chunks share the message's id and carry the text", turn[1].includes('"messageId":"m1"') && turn[2].includes('"messageId":"m1"') && turn[1].includes('"text":"Hello, '));
  ok("the usage counts the request", turn[3].includes('"used":16,"size":200000'));
  ok("the answer: the stop reason and the usage", turn[4].endsWith('"result":{"stopReason":"end_turn","usage":{"inputTokens":12,"outputTokens":4}}}'));

  // A message mid-turn steers the turn: the fake's next reply echoes what it got.
  const slow = send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "slow please" }] });
  await until(() => out.some((l) => l.includes("agent_message_chunk")));
  const steer = send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "and also this" }] });
  await until(() => out.some((l) => l.includes('"id":' + steer)));
  const steered = taken();
  const texts = steered.filter((l) => l.includes("agent_message_chunk")).map((l) => /"text":"([^"]*)"/.exec(l)?.[1] ?? "").join("");
  eq("the first reply, then a second request with the steered message, both prompts answered at the end", texts, "Working on it for a while now.You said: and also this");
  eq("in the order the prompts came", steered.filter((l) => l.includes('"result"')).map((l) => /"id":(\d+)/.exec(l)?.[1] ?? "").join(","), slow + "," + steer);

  // A reply with tool calls: each announced and ended, the batch's results read by the next request.
  const ran = send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "run it" }] });
  await until(() => out.some((l) => l.includes('"id":' + ran)));
  const batch = taken();
  const calls = batch.filter((l) => l.includes('"sessionUpdate":"tool_call"')).map((l) => (/"title":"([^"]+)","kind":"([^"]+)","status":"([^"]+)","rawInput":(\{[^}]*\})/.exec(l) ?? []).slice(1).join(" "));
  eq("the calls announced with their tool, kind and input, one after the other since Bash mutates", calls.join(" | "), 'Bash execute in_progress {"command":"echo hi; echo there"} | Read read in_progress {"file_path":"a.txt"}');
  const ends = batch.filter((l) => l.includes('"sessionUpdate":"tool_call_update"')).map((l) => (/"toolCallId":"([^"]+)","status":"([^"]+)","content":\[\{"type":"content","content":\{"type":"text","text":"([^"]*)"/.exec(l) ?? []).slice(1).join(" "));
  eq("each ended with its text, the command's output and the file's numbered lines", ends.join(" | "), "call_1 completed hi\\nthere | call_2 completed      1\\tone\\n     2\\ttwo");
  ok("the command's raw output carries the exit code", batch.some((l) => l.includes('"rawOutput":{"output":"hi\\nthere\\n","exitCode":0,"timedOut":false}')));
  eq("then the reply to the results, and the turn's answer", batch.filter((l) => l.includes("agent_message_chunk")).map((l) => /"text":"([^"]*)"/.exec(l)?.[1] ?? "").join(""), "Running it.It said hi.");

  const held = send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "hold on" }] });
  await until(() => out.some((l) => l.includes('"text":"Hold')));
  send("session/cancel", { sessionId: sid }, true);
  await until(() => out.some((l) => l.includes('"id":' + held)));
  ok("a cancel answers the prompt cancelled", taken().some((l) => l.includes('"id":' + held + ',"result":{"stopReason":"cancelled"')));

  const failing = send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "fail now" }] });
  await until(() => out.some((l) => l.includes('"id":' + failing)));
  ok("a model error fails the prompt with its message", taken().some((l) => l.includes('"error":{"code":-32603,"message":"model unavailable"}')));

  send("session/set_config_option", { sessionId: sid, configId: "mode", value: "plan" });
  const mode = taken();
  ok("an option set answers the options and a mode its update", mode[0].includes('"currentValue":"plan"') && mode[1].includes('"sessionUpdate":"current_mode_update","currentModeId":"plan"'));
  send("session/set_config_option", { sessionId: sid, configId: "model", value: "fake/huge" });
  ok("a value not offered is refused", taken()[0].includes('"error":{"code":-32602,"message":"no model fake/huge"}'));
  send("session/set_config_option", { sessionId: sid, configId: "model", value: "anthropic/claude-haiku-4-5" });
  ok("another model brings its own efforts, the kept one standing when it takes it", taken()[0].includes('"currentValue":"anthropic/claude-haiku-4-5"') && out.length === 0);
  send("session/set_config_option", { sessionId: sid, configId: "model", value: "fake/fake" });
  taken();

  send("session/fork", { sessionId: sid, cwd: "/p", mcpServers: [] });
  const forked = taken();
  const fid = /"sessionId":"([^"]+)"/.exec(forked[0])?.[1] ?? "";
  ok("a fork is a session of its own", fid.startsWith("h-") && fid !== sid && agent.count() === 2);
  const echo = send("session/prompt", { sessionId: fid, prompt: [{ type: "text", text: "what" }] });
  await until(() => out.some((l) => l.includes('"id":' + echo)));
  const forkLines = taken();
  eq("with the conversation so far", forkLines.filter((l) => l.includes("agent_message_chunk")).map((l) => /"text":"([^"]*)"/.exec(l)?.[1] ?? "").join("") + " · " + String(forkLines.length), "You said: what · 4");

  send("session/load", { sessionId: "h-gone", cwd: "/p", mcpServers: [] });
  ok("a session this process does not hold is refused, so the client starts a new one", taken()[0].includes('"error":{"code":-32602,"message":"no such session here: h-gone"}'));
  send("session/load", { sessionId: sid, cwd: "/p", mcpServers: [] });
  ok("one it holds is reopened in place", taken()[0].includes('"sessionId":"' + sid + '"'));
  send("fs/read_text_file", {});
  ok("an unknown method", taken()[0].includes('"code":-32601'));
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
