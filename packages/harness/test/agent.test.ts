// The agent over a sink server and the fake model: initialize's capabilities; a session with its
// options (the models by provider, the model's efforts, the modes), commands and usage; a prompt
// streamed as chunks and answered with the stop reason and usage; `_meta.widecode` kept and put
// in the system prompt; a prompt sent mid-turn steering the turn and answered with it; a tool
// call announced, run and ended, its result read by the next request; a cancel answering
// `cancelled`; an option set, a mode's update, plan mode's tools; a fork carrying the messages;
// an unknown method and session refused; the session's file, its title, /title, a load in another
// process showing the turns again, a resume, a batch cut off by its process's end given results;
// /compact and the loop's own compaction, the file's entries, the context after a load; a prompt
// template announced as a command and expanded as the user's message.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAgent } from "../acp/agent.ts";
import { AcpServer, Incoming } from "../acp/server.ts";
import { Auth } from "../auth.ts";
import { registryFor } from "../cli.ts";
import { HarnessConfig } from "../config.ts";
import { ModelClient } from "../model/client.ts";
import { FakeClient } from "../model/fake.ts";
import { HarnessPaths } from "../paths.ts";
import { Entry } from "../session/entries.ts";
import { SessionStore } from "../session/store.ts";
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
  mkdirSync(join(folder, ".widecode", "prompts"), { recursive: true });
  writeFileSync(join(folder, ".widecode", "prompts", "greet.md"), "---\ndescription: Greet someone\nargument-hint: <name>\n---\nGreet $1 and $@.\n");
  const server = new AcpServer();
  const out: string[] = [];
  server.sink = (line: string) => out.push(line);
  const config = new HarnessConfig();
  const registry = registryFor(config, true);
  const agent = new AcpAgent(server, new ModelClient(registry, new Auth(join(folder, "auth.json")), "node", FakeClient.fromText(FIXTURE)), new ToolSet(builtInTools()), registry, config, "test", "linux", new HarnessPaths(join(folder, "home")));
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
  ok("a prompt template announced beside them with its description and argument hint", made[1].includes('{"name":"greet","description":"Greet someone","input":{"type":"text","hint":"<name>"}}'));

  const first = send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "hello there" }] });
  await until(() => out.some((l) => l.includes('"id":' + first)));
  const turn = taken();
  eq("the thought, the text in chunks, the usage, then the answer", turn.map((l) => (l.includes("agent_thought_chunk") ? "thought" : l.includes("agent_message_chunk") ? "chunk" : l.includes("usage_update") ? "usage" : l.includes('"result"') ? "answer" : "?")).join(","), "thought,chunk,chunk,usage,answer");
  ok("the chunks share the message's id and carry the text", turn[1].includes('"messageId":"m1"') && turn[2].includes('"messageId":"m1"') && turn[1].includes('"text":"Hello, '));
  ok("the usage counts the request", turn[3].includes('"used":16,"size":200000'));
  ok("the answer: the stop reason and the usage", turn[4].endsWith('"result":{"stopReason":"end_turn","usage":{"inputTokens":12,"cachedReadTokens":0,"cachedWriteTokens":0,"outputTokens":4}}}'));

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
  eq("each ended with its text, the command's output and the file's numbered lines", ends.join(" | "), "call_1 completed hi\\nthere | call_2 completed 1\\tone\\n2\\ttwo");
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
  ok("a session with no file here is refused, so the client starts a new one", taken()[0].includes('"error":{"code":-32602,"message":"no such session here: h-gone"}'));
  const again = send("session/load", { sessionId: sid, cwd: "/p", mcpServers: [] });
  await until(() => out.some((l) => l.includes('"id":' + again)));
  const shown = taken();
  ok("one it holds is shown again, then reopened in place", shown[0].includes('"sessionUpdate":"user_message_chunk","messageId":"u1","content":{"type":"text","text":"hello there"}') && shown[shown.length - 3].includes('"sessionId":"' + sid + '"'));
  send("fs/read_text_file", {});
  ok("an unknown method", taken()[0].includes('"code":-32601'));

  // The session's file: every message, the model it started on, the changes, the title the first turn brought.
  const paths = new HarnessPaths(join(folder, "home"));
  const store = new SessionStore(paths.sessionsDir(folder));
  await until(() => agent.titleOf(sid).length > 0);
  const kinds = readFileSync(store.pathOf(sid), "utf8").split("\n").filter((l) => l.length > 0).map((l) => Entry.parse(l)).map((e) => (e === null ? "?" : e.kind === "message" ? e.role[0] + e.id : e.kind + (e.value.length > 0 ? ":" + e.value : "")));
  eq("the file's entries", kinds.join(" "), "session model:fake/fake uu1 am1 title:Fake session title uu2 am2 uu3 am3 uu4 am4 uu5 am5 uu6 am6 uu7 mode:plan model:anthropic/claude-haiku-4-5 model:fake/fake");
  eq("the fork's file holds the branch and its own turn", String(existsSync(store.pathOf(fid))) + " " + readFileSync(store.pathOf(fid), "utf8").split("\n").filter((l) => l.includes('"text":"You said: what"')).length, "true 1");
  ok("the list: both, newest first, the title read from the tail", /^\{"sessions":\[\{"sessionId":"h-[^"]+","cwd":"[^"]+","title":"Fake session title","updatedAt":\d+\},\{"sessionId":"h-[^"]+","cwd":"[^"]+","title":"Fake session title","updatedAt":\d+\}\]\}$/.test((send("session/list", { cwd: folder }), /"result":(.*)\}$/.exec(taken()[0])?.[1] ?? "")));

  const named = send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "/title Reading files" }] });
  const naming = taken();
  ok("/title with words names the session so, outside the conversation", naming[0].includes('"text":"Titled: Reading files"') && naming[1].includes('"id":' + named + ',"result":{"stopReason":"end_turn"') && agent.titleOf(sid) === "Reading files" && readFileSync(store.pathOf(sid), "utf8").includes('"kind":"title","id":"e6","parentId":"e5","at":') && store.list(folder)[0].title === "Reading files");
  const asked = send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "/title" }] });
  await until(() => out.some((l) => l.includes('"id":' + asked)));
  ok("/title alone asks the model again", taken()[0].includes('"text":"Titled: Fake session title"') && agent.titleOf(sid) === "Fake session title");

  // Compaction: /compact summarizes everything so far, the summary the context from now on, the file keeping the entry; the loop compacts on its own past the threshold, keeping the tail.
  const compacted = send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "/compact keep the file names" }] });
  await until(() => out.some((l) => l.includes('"id":' + compacted)));
  const comp = taken();
  const compactionsOf = (): Entry[] => {
    const found: Entry[] = [];
    for (const l of readFileSync(store.pathOf(sid), "utf8").split("\n")) {
      const e = l.startsWith('{"kind":"compaction"') ? Entry.parse(l) : null;
      if (e !== null) found.push(e);
    }
    return found;
  };
  const usedAfter = /"used":(\d+)/.exec(comp[0])?.[1] ?? "none";
  const before = compactionsOf().length > 0 ? compactionsOf()[0].tokensBefore : 0;
  eq("the usage with the context after, the note with the sizes, the answer", comp.map((l) => (l.includes("usage_update") ? "usage:" + usedAfter : l.includes("agent_message_chunk") ? "note:" + (/"text":"([^"]*)"/.exec(l)?.[1] ?? "") : l.includes('"id":' + compacted) ? "answer" : "?")).join(" "), "usage:" + usedAfter + " note:Compacted: " + String(before) + " tokens to " + usedAfter + ". answer");
  ok("the sizes are counts", before > 0 && Number(usedAfter) > 0);
  eq("the file's compaction entry: the summary from the six user messages so far with the hint, nothing kept", compactionsOf().map((e) => e.summary + " / " + e.firstKeptEntryId).join(" | "), "Goal\nA fake summary of 6 user messages. Hint: keep the file names / ");
  const after = send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "after compaction" }] });
  await until(() => out.some((l) => l.includes('"id":' + after)));
  eq("the conversation goes on from the summary", taken().filter((l) => l.includes("agent_message_chunk")).map((l) => /"text":"([^"]*)"/.exec(l)?.[1] ?? "").join(""), "You said: after compaction");
  agent.loop.compactAt = 1;
  agent.loop.keepTokens = 8;
  const tiny = send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "tiny" }] });
  await until(() => out.some((l) => l.includes('"id":' + tiny)));
  const auto = taken();
  agent.loop.compactAt = 200000;
  eq("past the threshold the loop compacts before the request, the usage first, then the reply", (auto[0].includes("usage_update") ? "usage " : "") + auto.filter((l) => l.includes("agent_message_chunk")).map((l) => /"text":"([^"]*)"/.exec(l)?.[1] ?? "").join(""), "usage You said: tiny");
  eq("the second entry folds the earlier summary in and keeps the turn's words", compactionsOf().map((e) => e.summary + " / " + e.firstKeptEntryId)[1], "Goal\nA fake summary of 1 user messages. An earlier summary was folded in. / u9");

  // Another process: the session from its file, its turns shown again, its mode and model as left, a batch its process left unfinished given its results.
  writeFileSync(store.pathOf("h-cut"), [
    '{"kind":"session","id":"h-cut","parentId":"","at":1,"cwd":' + JSON.stringify(folder) + ',"version":1}',
    '{"kind":"model","id":"e1","parentId":"","at":1,"value":"fake/fake"}',
    '{"kind":"message","id":"u1","parentId":"e1","at":2,"role":"user","parts":[{"kind":"text","text":"read it"}]}',
    '{"kind":"message","id":"m1","parentId":"u1","at":3,"role":"assistant","parts":[{"kind":"text","text":"Reading."},{"kind":"tool_call","callId":"call_9","name":"Read","inputJson":"{\\"file_path\\":\\"a.txt\\"}"}]}',
  ].join("\n") + "\n");
  const out2: string[] = [];
  const server2 = new AcpServer();
  server2.sink = (line: string) => out2.push(line);
  const agent2 = new AcpAgent(server2, new ModelClient(registry, new Auth(join(folder, "auth.json")), "node", FakeClient.fromText(FIXTURE)), new ToolSet(builtInTools()), registry, config, "test", "linux", paths);
  agent2.receive(new Incoming("session/load", { sessionId: sid, cwd: folder, mcpServers: [] }, "1"));
  await until(() => out2.some((l) => l.includes('"id":1,')));
  const replayed = out2.splice(0, out2.length);
  eq(
    "the turns shown again: the prompts with their ids, the thoughts and texts, each call completed with its text, then the answer with the options as left",
    replayed.map((l) => (l.includes('"user_message_chunk"') ? "user:" + (/"messageId":"([^"]+)"/.exec(l)?.[1] ?? "") : l.includes('"agent_thought_chunk"') ? "thought" : l.includes('"agent_message_chunk"') ? "text" : l.includes('"sessionUpdate":"tool_call"') ? "call:" + (/"title":"([^"]+)","kind":"([^"]+)","status":"([^"]+)"/.exec(l) ?? []).slice(1).join("/") : l.includes('"id":1,') ? "answer" : l.includes("usage_update") ? "usage" : l.includes("available_commands") ? "commands" : "?")).join(" "),
    "user:u1 thought text user:u2 text user:u3 text user:u4 text call:Bash/execute/completed call:Read/read/completed text user:u6 text user:u7 user:u8 text user:u9 text answer commands usage",
  );
  ok("a call shown again carries its output and the result text", replayed.some((l) => l.includes('"toolCallId":"call_1","title":"Bash","kind":"execute","status":"completed","rawInput":{"command":"echo hi; echo there"},"locations":[],"content":[{"type":"content","content":{"type":"text","text":"hi\\nthere"}}],"rawOutput":{"output":"hi\\nthere\\n","exitCode":0,"timedOut":false}')));
  ok("the mode and model as left, the title known", replayed[replayed.length - 3].includes('"currentValue":"plan"') && replayed[replayed.length - 3].includes('"currentValue":"fake/fake"') && agent2.titleOf(sid) === "Fake session title");
  eq("the context from the last compaction: its kept messages and its summary", agent2.contextOf(sid), "u9,m9 Goal\nA fake summary of 1 user messages. An earlier summary was folded in.");
  agent2.receive(new Incoming("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "what now" }] }, "2"));
  await until(() => out2.some((l) => l.includes('"id":2,')));
  eq("and it goes on, the reply echoing the prompt, kept in the file", out2.filter((l) => l.includes("agent_message_chunk")).map((l) => /"text":"([^"]*)"/.exec(l)?.[1] ?? "").join("") + " " + String(readFileSync(store.pathOf(sid), "utf8").includes('"text":"You said: what now"')), "You said: what now true");
  out2.splice(0, out2.length);
  agent2.receive(new Incoming("session/resume", { sessionId: "h-cut", cwd: folder, mcpServers: [] }, "3"));
  await until(() => out2.some((l) => l.includes('"id":3,')));
  eq("a resume shows nothing again", out2.filter((l) => l.includes("session/update")).map((l) => /"sessionUpdate":"([^"]+)"/.exec(l)?.[1] ?? "?").join(","), "available_commands_update,usage_update");
  const cut = readFileSync(store.pathOf("h-cut"), "utf8").split("\n").filter((l) => l.length > 0);
  eq("the batch cut off by its process's end has its results, as errors", String(cut.length) + " " + (Entry.parse(cut[4])?.message().parts.map((p) => p.kind + ":" + p.callId + ":" + p.text + ":" + String(p.isError)).join(",") ?? "?"), "5 tool_result:call_9:interrupted:true");

  // A prompt template: `/greet words` is the template's body with the words put in.
  send("session/new", { cwd: folder, mcpServers: [], _meta: { widecode: { trusted: true } } });
  const fresh = taken();
  const tsid = /"sessionId":"([^"]+)"/.exec(fresh[0])?.[1] ?? "";
  const greeted = send("session/prompt", { sessionId: tsid, prompt: [{ type: "text", text: '/greet Alice "and Bob"' }] });
  await until(() => out.some((l) => l.includes('"id":' + greeted)));
  eq("a prompt naming a template is sent as its expanded text", taken().filter((l) => l.includes("agent_message_chunk")).map((l) => /"text":"([^"]*)"/.exec(l)?.[1] ?? "").join(""), "You said: Greet Alice and Alice and Bob.");

  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
