// The MCP client against the agent package's server: the servers of a session's `mcpServers`, the
// handshake and the tools listed (named for the model and titled for the client), a call answered
// as an event stream with progress before the answer, a tool's error, a call aborted while it
// waits, a wrong token and a server not there; then a session given the server, whose turn calls
// one of its tools, titled as the acp plugin knows it.
import { McpCall, McpServer, McpTool } from "../src/agent/mcp.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAgent } from "../src/harness/acp/agent.ts";
import { AcpServer, Incoming } from "../src/harness/acp/server.ts";
import { Auth } from "../src/harness/auth.ts";
import { registryFor } from "../src/harness/cli.ts";
import { HarnessConfig } from "../src/harness/config.ts";
import { Abort } from "../src/harness/loop/abort.ts";
import { ModelClient } from "../src/harness/model/client.ts";
import { FakeClient } from "../src/harness/model/fake.ts";
import { HarnessPaths } from "../src/harness/paths.ts";
import { McpLink } from "../src/harness/tools/mcp.ts";
import { ToolSet, builtInTools } from "../src/harness/tools/tool.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const until = (what: () => boolean): Promise<void> =>
  new Promise<void>((settle) => {
    const tick = (): void => {
      if (what()) settle();
      else setTimeout(tick, 10);
    };
    tick();
  });

const main = async (): Promise<void> => {
  const server = new McpServer("widecode");
  server.progressMs = 20;
  const schema = '{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}';
  server.tools.push(new McpTool("echo", "Echo the text", schema, "", "test", 0, []));
  server.tools.push(new McpTool("slow", "Answer after a while", '{"type":"object","properties":{}}', "", "test", 0, []));
  server.tools.push(new McpTool("boom", "Fail", '{"type":"object","properties":{}}', "", "test", 0, []));
  server.tools.push(new McpTool("hold", "Never answer", '{"type":"object","properties":{}}', "", "test", 0, []));
  server.onToolCall = (call: McpCall) => {
    const name = call.tool.name;
    if (name === "echo") server.answer(call.id, "echo: " + ((JSON.parse(call.args) as { text: string }).text ?? ""), false);
    else if (name === "slow") setTimeout(() => server.answer(call.id, "slept", false), 120);
    else if (name === "boom") server.answer(call.id, "it broke", true);
  };
  const url = await server.start();
  const token = server.tokenFor("harness");

  const links = McpLink.fromSession(JSON.stringify([{ type: "http", name: "widecode", url, headers: [{ name: "Authorization", value: "Bearer " + token }] }, { type: "stdio", name: "local", command: "x" }, { type: "http", name: "", url }]));
  eq("a session's HTTP servers, with their headers", links.map((l) => l.name + " " + l.headers.map((h) => h[0]).join(",")).join(" | "), "widecode Authorization");
  const link = links[0];
  const listing = await link.listTools(new Abort());
  eq("the tools listed, named for the model and titled for the client", listing.error + listing.tools.map((t) => t.calledAs() + "=" + t.titledAs()).join(" "), "mcp__widecode__echo=widecode_echo mcp__widecode__slow=widecode_slow mcp__widecode__boom=widecode_boom mcp__widecode__hold=widecode_hold");
  eq("with the schema", listing.tools[0].schemaJson, schema);
  const echoed = await link.callTool("echo", '{"text":"hi"}', new Abort());
  eq("a call's text", echoed.text + " " + String(echoed.isError), "echo: hi false");
  const slow = await link.callTool("slow", "{}", new Abort());
  eq("an answer after progress notifications", slow.text + " " + String(slow.isError), "slept false");
  const boom = await link.callTool("boom", "{}", new Abort());
  eq("a tool's error", boom.text + " " + String(boom.isError), "it broke true");
  const abort = new Abort();
  const held = link.callTool("hold", "{}", abort);
  setTimeout(() => abort.fire(), 80);
  const dropped = await held;
  eq("a call aborted while it waits", dropped.text + " " + String(dropped.isError), "interrupted true");
  const wrong = await new McpLink("widecode", url, [["Authorization", "Bearer nope"]]).listTools(new Abort());
  eq("a wrong token", wrong.error + " " + String(wrong.tools.length), "the server answered 401: unauthorized 0");
  const gone = await new McpLink("gone", "http://127.0.0.1:1/mcp", []).listTools(new Abort());
  ok("a server not there", gone.error.length > 0 && gone.tools.length === 0);

  // A session given the server: its tools offered, a call titled as the plugin knows it.
  const folder = mkdtempSync(join(tmpdir(), "harness-mcp-"));
  const acp = new AcpServer();
  const out: string[] = [];
  acp.sink = (line: string) => out.push(line);
  const config = new HarnessConfig();
  const registry = registryFor(config, true);
  const fixture = ['{"match":"echo","text":"Echoing.","tools":[{"name":"mcp__widecode__echo","input":{"text":"there"}}]}', '{"match":"result","text":"Echoed."}'].join("\n");
  const agent = new AcpAgent(acp, new ModelClient(registry, new Auth(join(folder, "auth.json")), "node", FakeClient.fromText(fixture)), new ToolSet(builtInTools()), registry, config, "test", "linux", new HarnessPaths(join(folder, "home")));
  agent.receive(new Incoming("session/new", { cwd: folder, mcpServers: [{ type: "http", name: "widecode", url, headers: [{ name: "Authorization", value: "Bearer " + token }] }] }, "1"));
  const sid = /"sessionId":"([^"]+)"/.exec(out[0])?.[1] ?? "";
  agent.receive(new Incoming("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "echo it" }] }, "2"));
  await until(() => out.some((l) => l.includes('"id":2,')));
  const call = out.find((l) => l.includes('"sessionUpdate":"tool_call"')) ?? "";
  eq("the call titled widecode_echo, its input", (/"title":"([^"]+)","kind":"([^"]+)","status":"([^"]+)","rawInput":(\{[^}]*\})/.exec(call) ?? []).slice(1).join(" "), 'widecode_echo other in_progress {"text":"there"}');
  ok("its result from the server, then the reply", out.some((l) => l.includes('"sessionUpdate":"tool_call_update"') && l.includes('"text":"echo: there"')) && out.filter((l) => l.includes("agent_message_chunk")).map((l) => /"text":"([^"]*)"/.exec(l)?.[1] ?? "").join("") === "Echoing.Echoed.");
  server.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
