// Subagents: a Task call runs its prompt as a session of its own on the same model and folder,
// with the tools but Task (a Task inside one is refused), its last reply the call's text and its
// requests' cost the session's; the call reaches the client titled Task with its input, which the
// acp plugin draws as an agent; an empty prompt is refused.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAgent } from "../src/harness/acp/agent.ts";
import { AcpServer, Incoming } from "../src/harness/acp/server.ts";
import { Auth } from "../src/harness/auth.ts";
import { registryFor } from "../src/harness/cli.ts";
import { HarnessConfig } from "../src/harness/config.ts";
import { Abort } from "../src/harness/loop/abort.ts";
import { LoopListener } from "../src/harness/loop/listener.ts";
import { AgentLoop, LoopSession } from "../src/harness/loop/loop.ts";
import { ModelClient } from "../src/harness/model/client.ts";
import { FakeClient } from "../src/harness/model/fake.ts";
import { Usage } from "../src/harness/model/message.ts";
import { HarnessPaths } from "../src/harness/paths.ts";
import { ToolOutcome, ToolSet, builtInTools } from "../src/harness/tools/tool.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const FIXTURE = [
  '{"match":"delegate","text":"Delegating.","tools":[{"name":"Task","input":{"description":"Find the port","prompt":"look for the port in a.txt","subagent_type":"general-purpose"}}]}',
  '{"match":"look","text":"Reading.","tools":[{"name":"Read","input":{"file_path":"a.txt"}},{"name":"Task","input":{"description":"Deeper","prompt":"go deeper"}}]}',
  '{"match":"result","text":"The port is 8443.","input":40,"output":6}',
  '{"match":"result","text":"The subagent found 8443."}',
  '{"match":"empty","text":"Trying.","tools":[{"name":"Task","input":{"description":"Nothing","prompt":"  "}}]}',
  '{"match":"result","text":"It refused."}',
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
  const folder = mkdtempSync(join(tmpdir(), "harness-sub-"));
  writeFileSync(join(folder, "a.txt"), "port = 8443\n");
  const config = new HarnessConfig();
  const registry = registryFor(config, true);
  const client = new ModelClient(registry, new Auth(join(folder, "auth.json")), "node", FakeClient.fromText(FIXTURE));
  const loop = new AgentLoop(client, new ToolSet(builtInTools()));
  const s = new LoopSession();
  s.model = "fake/fake";
  s.cwd = folder;
  s.system = ["Be brief."];
  const l = new LoopListener();
  const ends: string[] = [];
  const sub: number[] = [];
  l.onToolEnd = (id: string, o: ToolOutcome) => ends.push(id + " " + String(o.isError) + " " + o.text + " " + o.rawOutputJson);
  l.onSubUsage = (u: Usage) => sub.push(u.input);
  const end = await loop.run(s, "delegate it", l, new Abort());
  eq("the Task's text: the subagent's last reply, what it did", ends.join(" | "), 'call_1 false The port is 8443. {"calls":2,"stopReason":"end_turn"}');
  eq("then the reply, the subagent's messages kept out of the session", end.stopReason + " " + s.messages.map((m) => m.role[0] + ":" + m.text()).join(" ") + " " + String(s.messages.length), "end_turn u:delegate it a:Delegating. u: a:The subagent found 8443. 4");
  eq("the subagent's requests counted apart", sub.join(","), "10,40");
  ends.length = 0;
  await loop.run(s, "empty task", l, new Abort());
  eq("an empty prompt is refused", ends.join(""), "call_4 true Task needs a prompt ");

  // Through ACP: the call titled Task with its input, which the plugin draws as an agent.
  const server = new AcpServer();
  const out: string[] = [];
  server.sink = (line: string) => out.push(line);
  const agent = new AcpAgent(server, new ModelClient(registry, new Auth(join(folder, "auth.json")), "node", FakeClient.fromText(FIXTURE)), new ToolSet(builtInTools()), registry, config, "test", "linux", new HarnessPaths(join(folder, "home")));
  agent.receive(new Incoming("session/new", { cwd: folder, mcpServers: [] }, "1"));
  const sid = /"sessionId":"([^"]+)"/.exec(out[0])?.[1] ?? "";
  agent.receive(new Incoming("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "delegate it" }] }, "2"));
  await until(() => out.some((l2) => l2.includes('"id":2,')));
  const calls = out.filter((l2) => l2.includes('"sessionUpdate":"tool_call"'));
  ok("one call reaches the client: Task, with the subagent's type", calls.length === 1 && calls[0].includes('"title":"Task","kind":"other","status":"in_progress","rawInput":{"description":"Find the port","prompt":"look for the port in a.txt","subagent_type":"general-purpose"}'));
  ok("its end carries the report", out.some((l2) => l2.includes('"sessionUpdate":"tool_call_update"') && l2.includes('"text":"The port is 8443."')));
  // The turn's two requests (10 in, 3 out each, the fake's default) and the subagent's two (10 and 40 in, 3 and 6 out).
  const answer = out.find((l2) => l2.includes('"id":2,')) ?? "";
  eq("the turn's usage counts the subagent's requests too", /"usage":(\{[^}]*\})/.exec(answer)?.[1] ?? answer, '{"inputTokens":70,"cachedReadTokens":0,"cachedWriteTokens":0,"outputTokens":15}');
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
