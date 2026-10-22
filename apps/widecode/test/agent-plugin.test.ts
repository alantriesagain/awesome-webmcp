// ffi: @light/plugins/native/ffi.json
// An agent a plugin brings: chosen by its id, the conversation talks to it. A message starts its
// process (api.process.spawn, `cat` here, echoing what it is sent), the plugin turns the process's
// lines into events (api.conversation.apply), and the chat, the Tools tab and the status show what
// they say: the prompt taken up, the reply, a call with its command and result, the turn's end, the
// model and context. A request's reply reaches the plugin; the screen names the agent; /new stops
// its process; choosing Claude Code again, or an agent no plugin brought, says so.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { Answer, Reply } from "@widecode/conversation/requests.ts";
import { PluginSource } from "@light/plugins/sources.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { Run } from "@bootstrapp/light/native/tui/lines.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const echo = `widecode.plugin({
  id: "echo-agent",
  activate(api) {
    let proc = null;
    let n = 0;
    let last = "";
    const apply = (e) => api.conversation.apply(e);
    const lines = (ls) => {
      for (const l of ls) {
        const m = JSON.parse(l);
        n++;
        apply([
          { type: "take", text: m.text },
          { type: "turn", text: m.text },
          { type: "block", key: "t" + n, kind: "text", text: "echo: " + m.text },
          { type: "finish", key: "t" + n },
          { type: "block", key: "c" + n, kind: "tool", id: "c" + n, name: "shell", category: "run", summary: "echo " + m.text, command: "echo " + m.text },
          { type: "result", id: "c" + n, text: m.text },
          { type: "end", durationMs: 1200, costUsd: 0.5 },
          { type: "usage", model: "echo-1", contextUsed: 100, contextSize: 1000 },
        ]);
      }
    };
    api.agents.register({
      id: "echo",
      name: "Echo",
      start(o) {
        proc = api.process.spawn(["cat"], { cwd: o.cwd }, { lines, exit: () => apply({ type: "process", state: "ended" }) });
        if (!proc.started) return "cannot start cat";
        apply([{ type: "process", state: "running" }, { type: "session", id: "echo-session", model: "echo-1" }]);
        return "";
      },
      send(text) {
        proc.write(JSON.stringify({ text }));
        return "";
      },
      respond(request, reply) {
        last = request.id + ":" + reply.state + ":" + reply.answers.map((a) => a.labels.join("+")).join(",");
      },
      reset() {
        if (proc !== null) proc.stop(100);
        proc = null;
      },
      stop() {
        if (proc !== null) proc.stop(100);
      },
      kill() {
        if (proc !== null) proc.kill();
      },
    });
    api.commands.add({ name: "/ask", run: () => apply({ type: "request", id: "r1", category: "question", questions: [{ question: "Which?", options: [{ label: "Red" }, { label: "Blue" }] }] }) });
    api.commands.add({ name: "/last", run: () => api.tell("responded " + last) });
  },
});`;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-agent-plugin-"));
  writeFileSync(join(folder, "a.txt"), "a\n");
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  w.js.extra = [new PluginSource("echo.js", echo)];
  w.host.session.agentId.value = "echo";
  w.start(null, new NoStateFile(), []);
  await w.host.load();
  eq("the agent chosen by its id talks to the conversation", c.agent.id() + " " + c.agent.name() + " " + String(c.started), "echo Echo false");

  const chat = (): string[] => {
    const s = w.chat.pane.source;
    s.prepare(80);
    const out: string[] = [];
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 80).runs.map((r: Run) => r.text).join("").replace(/\s+$/, ""));
    return out;
  };
  w.host.roles.chat.submit("hello");
  ok("a message starts its process", c.started);
  for (let i = 0; i < 40 && c.model.turns.length === 0; i++) await wait(25);
  await wait(50);
  const lines = chat();
  ok("its process's lines, as events: the prompt taken up, the reply", lines.some((l) => l.includes("<Me>: hello")) && lines.some((l) => l.includes("echo: hello")));
  ok("a call with its command, on one line in the chat", lines.some((l) => l.startsWith("· shell echo hello")));
  eq("the turn ended, nothing queued", String(c.model.running) + " " + String(c.model.pending.length) + " " + String(c.model.turns[0].result?.costUsd ?? -1), "false 0 0.5");
  eq("the session, the model and its context", c.sessionId + " " + c.info.modelId + " " + String(c.info.contextUsed) + "/" + String(c.info.contextSize), "echo-session echo-1 100/1000");
  eq("the call counts as a run", String(c.info.execs) + " " + String(c.info.calls), "1 1");
  const tools = w.tools.panel;
  if (tools !== null) tools.source.prepare(40);
  ok("the Tools tab lists the call", tools !== null && tools.source.rows.some((r) => r.item !== null && r.item.command === "echo hello"));

  w.host.roles.chat.submit("/ask");
  const asked = c.model.openRequests();
  ok("a request from the agent", asked.length === 1 && asked[0].questions[0].question === "Which?");
  if (asked.length === 1) {
    const reply = new Reply("answered");
    const a = new Answer("Which?", false);
    a.labels.push("Blue");
    reply.answers.push(a);
    c.respond(asked[0], reply);
  }
  w.host.roles.chat.submit("/last");
  eq("the user's reply reaches the plugin", w.host.screen.message.peek(), "responded r1:answered:Blue");
  ok("the screen names the agent", w.chat.pane.input.placeholder.startsWith("Write to Echo."));

  c.reset();
  await wait(300);
  ok("/new stops its process", !c.started);

  eq("Claude Code again", w.host.session.useAgent("claude") + c.agent.id(), "claude");
  ok("an agent no plugin brought: said", w.host.session.useAgent("nope") === "no agent named nope (there are opencode, dsh, claude, echo)");

  w.host.kernel.stop();
  w.js.killProcesses();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
