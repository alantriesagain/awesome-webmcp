// ffi: @lightstart/plugins/native/ffi.json
// lightcode's own tools over its MCP server (src/agent/mcp.ts), added by plugins (api.tools): the
// server refuses a request without its token, on another path or not a POST, answers initialize
// (the client's version when it knows it), a notification, tools/list (the ask plugin's AskUser and
// PresentPlan, a test plugin's), a call as an event stream (its tool's text, JSON for a value that
// is not text, an error thrown), a tool or method it has not, a body that is not JSON; a reload
// answers a call still waiting. Through the fake ACP agent (test/fake-acp.mjs), which
// calls the tools as opencode does: AskUser's questions in the request panel, the call drawn as
// the request (in the Tools tab as Ask and its question), progress while the user thinks, the
// choice or the user's own words back to the agent, Esc or a reload withdrawing it; PresentPlan's
// plan to approve in plan mode (approved, the agent leaves plan mode and is asked to carry it out
// after its turn; declined, the user's words go back). The tools renamed in the ask plugin's
// section are offered and drawn by those names. An agent that takes no MCP servers over HTTP, and
// an app with the ask and harness plugins switched off, get no server.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Item, TEXT, Turn } from "../src/conversation/model.ts";
import { PluginSource } from "@lightstart/plugins/sources.ts";
import type { Lightcode } from "../src/compose.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";
import { closeLightcode, openLightcode } from "./support/app.ts";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

/** A test plugin's tools: echo answers its arguments (a value, so JSON), boom throws, hold never answers. */
const probe = `lightcode.plugin({
  id: "probe",
  activate(api) {
    let cancelled = 0;
    api.tools.add({ name: "echo", description: "Echo", input: { type: "object", properties: { x: { type: "number" } } }, call: (args) => ({ got: args.x }) });
    api.tools.add({ name: "boom", call: () => { throw new Error("it broke"); } });
    api.tools.add({ name: "hold", call: () => new Promise(() => {}) });
    api.tools.add({ name: "ctx", call: (args, ctx) => ({ callId: ctx.callId, toolUseId: ctx.toolUseId }) });
    api.tools.add({ name: "cancel", call: (args, ctx) => new Promise((resolve) => { ctx.onCancel(() => { cancelled++; resolve("cancelled"); }); }) });
    api.tools.add({ name: "cancelled", call: () => cancelled });
  },
});`;

/** A request to `url`'s host and port: its status, content type and body (newlines as |). */
const send = (url: string, path: string, token: string, method: string, body: string): Promise<string> =>
  new Promise((resolve) => {
    const port = Number(url.slice(url.lastIndexOf(":") + 1, url.lastIndexOf("/")));
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (token.length > 0) headers["authorization"] = "Bearer " + token;
    const req = request({ host: "127.0.0.1", port: port, path: path, method: method, headers: headers }, (res: IncomingMessage) => {
      const parts: string[] = [];
      res.on("data", (c: Buffer) => {
        parts.push(c.toString("utf8"));
      });
      res.on("end", () => resolve(String(res.statusCode) + " " + String(res.headers["content-type"] ?? "") + " " + parts.join("").replace(/\n/g, "|")));
    });
    req.on("error", (e: Error) => resolve("error " + e.message));
    req.end(body);
  });

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "lightcode-mcp-"));
  const log = join(folder, "fake.log");
  const oldLog = join(folder, "old.log");
  const fake = join(process.cwd(), "test/fake-acp.mjs");
  const config: unknown = {
    acp: {
      agents: {
        fake: { name: "Fake", command: ["node", fake, "--log", log] },
        old: { name: "Old", command: ["node", fake, "--legacy", "--log", oldLog] },
      },
    },
  };
  const w = await openLightcode({
    folder,
    plugins: config,
    load: true,
    before: (w: Lightcode) => {
      w.js.extra = [new PluginSource("probe.js", probe)];
      w.host.session.agentId.value = "fake";
    },
  });
  const c = w.host.conversation;
  const mcp = w.js.mcp;
  mcp.progressMs = 30;

  // The server itself.
  const url = await mcp.start();
  ok("it listens on 127.0.0.1", url.startsWith("http://127.0.0.1:") && url.endsWith("/mcp"));
  const acpToken = mcp.tokenFor("acp");
  const post = (body: string): Promise<string> => send(url, "/mcp", acpToken, "POST", body);
  eq("no token", await send(url, "/mcp", "", "POST", "{}"), "401 text/plain unauthorized");
  eq("another path", await send(url, "/other", acpToken, "POST", "{}"), "404 text/plain not found");
  eq("a token no agent plugin was given", await send(url, "/mcp", "nope", "POST", "{}"), "401 text/plain unauthorized");
  eq("not a POST", await send(url, "/mcp", acpToken, "GET", ""), "405 text/plain only POST");
  eq("initialize: the client's version", await post('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}'), '200 application/json {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"lightcode","version":"1"}}}');
  ok("a version it does not know: its own", (await post('{"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":"1999-01-01"}}')).includes('"id":"a","result":{"protocolVersion":"2025-06-18"'));
  eq("a notification", await post('{"jsonrpc":"2.0","method":"notifications/initialized"}'), "202  ");
  const listed = await post('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
  const tools = (JSON.parse(listed.slice(listed.indexOf("{"))) as { result: { tools: { name: string }[] } }).result.tools;
  eq("the tools, the ask plugin's first, then the harness plugin's, then the test's", tools.map((t) => t.name).join(","), "AskUser,PresentPlan,screen,state,log,reload,api,check,config,echo,boom,hold,ctx,cancel,cancelled");
  const claudeToken = mcp.tokenFor("claude");
  ok("each agent plugin has a token of its own, kept", claudeToken !== acpToken && mcp.tokenFor("claude") === claudeToken);
  const probeToken = mcp.tokenFor("probe");
  const probeFile = mcp.configFile("probe");
  ok("a plugin's config file is written for its agent", probeFile.length > 0 && existsSync(probeFile));
  mcp.forgetOwner("probe");
  eq("a retired plugin's token is refused", await send(url, "/mcp", probeToken, "POST", "{}"), "401 text/plain unauthorized");
  ok("and its config file is gone", !existsSync(probeFile));
  ok("a new ask makes a new token", mcp.tokenFor("probe") !== probeToken);
  const forClaude = await send(url, "/mcp", claudeToken, "POST", '{"jsonrpc":"2.0","id":"c","method":"tools/list"}');
  eq("the ask plugin's tools are kept from Claude Code, which has its own", (JSON.parse(forClaude.slice(forClaude.indexOf("{"))) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).join(","), "screen,state,log,reload,api,check,config,echo,boom,hold,ctx,cancel,cancelled");
  ok("and a call of one with its token finds no such tool", (await send(url, "/mcp", claudeToken, "POST", '{"jsonrpc":"2.0","id":"d","method":"tools/call","params":{"name":"AskUser","arguments":{}}}')).includes("lightcode has no tool AskUser"));
  ok("with their input's schema", listed.includes('"required":["questions"]}') && listed.includes('"inputSchema":{"type":"object","properties":{"plan":{"type":"string","description":"The whole plan, in markdown."}},"required":["plan"]}'));
  eq("a call: an event stream", await post('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"x":1}}}'), '200 text/event-stream event: message|data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\\"got\\":1}"}],"isError":false}}||');
  ok("an error thrown", (await post('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"boom"}}')).includes('"text":"it broke"}],"isError":true'));
  ok("a tool it has not", (await post('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope"}}')).includes('"id":5,"error":{"code":-32602,"message":"lightcode has no tool nope"}'));
  ok("a method it has not", (await post('{"jsonrpc":"2.0","id":6,"method":"resources/list"}')).includes('"error":{"code":-32601,"message":"lightcode offers no resources/list"}'));
  ok("not JSON", (await post("nope")).includes('"id":null,"error":{"code":-32700'));
  const held = post('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"hold","arguments":{}}}');
  await wait(100);
  w.js.reload();
  const answered = await held;
  ok("a call still waiting when the plugins reload is answered (no progress without a token)", !answered.includes("notifications/progress") && answered.includes("lightcode's plugins reloaded") && answered.includes('"isError":true'));
  const progressed = post('{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"hold","arguments":{},"_meta":{"progressToken":"p1"}}}');
  await wait(100);
  w.js.reload();
  ok("with a progress token: a notification every few seconds while it waits", (await progressed).includes('"method":"notifications/progress","params":{"progressToken":"p1","progress":1}'));
  const meta = await post('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"ctx","arguments":{},"_meta":{"claudecode/toolUseId":"toolu_meta"}}}');
  ok("the agent's own tool-use id reaches the tool", meta.includes("toolu_meta") && meta.includes("callId"));
  const cancelling = post('{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"cancel","arguments":{}}}');
  await wait(100);
  await post('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":10}}');
  await cancelling;
  ok("a cancelled call runs what the tool registered", (await post('{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"cancelled"}}')).includes('"text":"1"'));

  // Through an agent, as opencode calls them.
  const idle = (): boolean => !c.model.running && c.model.pending.length === 0;
  const last = (): Turn => c.model.turns[c.model.turns.length - 1];
  const said = (t: Turn): string => t.body.children.filter((i: Item) => i.kind === TEXT).map((i: Item) => i.text).join(" ");
  const chat = (): string[] => {
    const s = w.chat.pane.source;
    s.prepare(80);
    const out: string[] = [];
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 80).runs.map((r: Run) => r.text).join("").replace(/\s+$/, ""));
    return out;
  };
  const panel = w.chat.pane.panel;
  const asking = async (text: string): Promise<Item | null> => {
    const before = c.model.turns.length;
    w.host.roles.chat.typed(text);
    await until(() => c.model.turns.length > before && c.model.openRequests().length > 0 && panel.active);
    const open = c.model.openRequests();
    return open.length > 0 ? open[0] : null;
  };

  const q = await asking("question");
  eq("AskUser: its question in the panel", q === null ? "none" : [q.category, q.name, q.questions[0].question, q.questions[0].header, q.questions[0].options.map((o) => o.label + ":" + o.description).join(",")].join(" | "), "question | AskUser | Which color? | Color | Red:warm,Blue:");
  ok("the agent was given the server and its token", readFileSync(log, "utf8").includes('"mcpServers":[{"type":"http","name":"lightcode","url":"' + url + '","headers":[{"name":"Authorization","value":"Bearer ' + acpToken + '"}]}]'));
  ok("drawn as the agent asking, not as a call", chat().includes("◆ Fake asks") && chat().some((l: string) => l.includes("Which color?")) && !chat().some((l: string) => l.includes("lightcode_AskUser")));
  await until(() => c.model.tool("call_AskUser") !== null);
  const asked = c.model.tool("call_AskUser");
  eq("the call, as the Tools tab names it", asked === null ? "none" : asked.category + " | " + asked.name + " | " + asked.summary, "question | Ask | Which color?");
  await wait(100);
  panel.key(new KeyEvent("char", "1", false, false, false), true);
  ok("the turn ends once answered", await until(idle));
  eq("the choice reached the agent, with progress meanwhile", said(last()), 'Tools: AskUser,PresentPlan,screen,state,log,reload,api,check,config,echo,boom,hold,ctx,cancel,cancelled; progress: yes; lightcode 2025-06-18 answered: The user answered:\n"Which color?": Red');
  eq("and the call holds the answer; the request is answered", (c.model.tool("call_AskUser")?.result?.text ?? "") + " | " + (q !== null ? q.state : ""), 'The user answered:\n"Which color?": Red | answered');

  await asking("question");
  w.host.roles.chat.typed("Green, with stripes");
  ok("the user's own words", (await until(idle)) && said(last()).endsWith('"Which color?": Green, with stripes'));

  w.host.roles.chat.typed("call state {}");
  ok("a harness plugin tool called by the agent: lightcode's state, the plugins with their states among it", (await until(idle)) && said(last()).includes("answered: {") && said(last()).includes('"id":"harness"') && said(last()).includes('"state":"running"'));

  const withdrawn = await asking("question");
  c.interrupt();
  ok("Esc: the turn ends and the question is withdrawn", (await until(idle)) && withdrawn !== null && withdrawn.state === "cancelled" && !panel.active && chat().some((l: string) => l.includes("◆ Fake asks  withdrawn")));

  w.host.roles.chat.typed("/plan");
  ok("in plan mode", await until(() => c.model.permissionMode === "plan"));
  const p = await asking("present");
  eq("PresentPlan: the plan to approve", p === null ? "none" : p.category + " | " + p.name + " | " + p.text, "plan | PresentPlan | 1. Write the test\n2. Make it pass");
  ok("drawn in the chat", chat().includes("◆ Plan ready for your approval") && chat().includes("│ 1. Write the test"));
  // The request comes over HTTP, the call over the agent's output: either may be first.
  await until(() => c.model.tool("call_PresentPlan") !== null);
  const presented = c.model.tool("call_PresentPlan");
  eq("its call, as the Tools tab names it: its first line", presented === null ? "none" : presented.category + " | " + presented.name + " | " + presented.summary, "plan | Plan | 1. Write the test");
  const turns = c.model.turns.length;
  panel.key(new KeyEvent("enter", "", false, false, false), true);
  ok("approved: the agent leaves plan mode, and is asked to carry the plan out after its turn", await until(() => c.model.turns.length === turns + 1 && idle()));
  eq("its mode, what it was told, what it was asked", c.model.permissionMode + " | " + said(c.model.turns[turns - 1]).slice(said(c.model.turns[turns - 1]).indexOf("answered: ") + 10) + " | " + said(last()), "build | The user approved the plan. Plan mode ends with this turn, and the next message asks you to carry the plan out: end this turn now, without making changes. | You said: The plan is approved: carry it out.");

  w.host.roles.chat.typed("/plan");
  await until(() => c.model.permissionMode === "plan");
  await asking("present");
  w.host.roles.chat.typed("Add a step for the docs");
  ok("declined: the user's words go back, the mode stays", (await until(idle)) && said(last()).endsWith("answered: The user did not approve the plan.\n\nAdd a step for the docs") && c.model.permissionMode === "plan");

  // A reload starts the plugins and the agent's process again.
  const reloaded = await asking("question");
  w.js.reload();
  ok("a reload withdraws a question still open", (await until(() => !panel.active)) && reloaded !== null && reloaded.state === "cancelled" && c.model.openRequests().length === 0);

  // An agent that takes no MCP server over HTTP.
  eq("another agent", w.host.session.useAgent("old"), "");
  c.reset();
  w.host.roles.chat.typed("question");
  ok("one without MCP over HTTP is given none", (await until(() => c.model.turns.length > 0 && said(last()) === "No lightcode server.")) && readFileSync(oldLog, "utf8").includes('"mcpServers":[]'));

  closeLightcode(w);

  /** An app with the ask plugin's section `section`, talking to the fake: what it says to "question", the request, the call. */
  const withSection = async (section: unknown, answer: boolean): Promise<string> => {
    const config: unknown = { ask: section, harness: section !== false, acp: { agents: { fake: { name: "Fake", command: ["node", fake] } } } };
    const w2 = await openLightcode({
      folder,
      plugins: config,
      load: true,
      before: (w: Lightcode) => {
        w.host.session.agentId.value = "fake";
      },
    });
    const c2 = w2.host.conversation;
    const lastSaid = (): string => (c2.model.turns.length > 0 ? said(c2.model.turns[c2.model.turns.length - 1]) : "");
    w2.host.roles.chat.submit("question");
    let out = "";
    if (answer && (await until(() => c2.model.openRequests().length > 0 && w2.chat.pane.panel.active))) {
      const r = c2.model.openRequests()[0];
      await until(() => c2.model.tool("call_ask_user") !== null);
      const call = c2.model.tool("call_ask_user");
      out = r.name + " | " + (call === null ? "no call" : call.category + " " + call.name) + " | ";
      w2.chat.pane.panel.key(new KeyEvent("char", "2", false, false, false), true);
    }
    await until(() => !c2.model.running && lastSaid().length > 0);
    out += lastSaid();
    closeLightcode(w2);
    return out;
  };

  const renamed: unknown = { names: { question: "ask_user", plan: "SubmitPlan" } };
  eq("renamed in its section: offered and drawn by those names", await withSection(renamed, true), 'ask_user | question Ask | Tools: ask_user,SubmitPlan,screen,state,log,reload,api,check,config; progress: no; lightcode 2025-06-18 answered: The user answered:\n"Which color?": Blue');
  // The ask and harness plugins switched off (no tools left): no server for the agent.
  eq("switched off: the agent gets no server", await withSection(false, false), "No lightcode server.");

  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
