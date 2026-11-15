// ffi: @lightstart/plugins/native/ffi.json
// The tools the agent has, in the Available tab of the tools column (plugins/tools/index.ts): Claude
// Code's from its init record (its own, then each MCP server's by its name, a server that failed
// with no tools, a tool of a server it did not list), each with its calls this session; an ACP
// agent's from its entry's tools command (test/fake-acp.mjs --tools, as opencode's
// `debug agent <mode>`: what the mode has, without opencode's invalid and question), with widecode's
// own tools under widecode's server, read again when the mode changes, what the mode's permission
// rules deny, limit or ask for said, and a call of widecode's tool counted; one with no tools
// command, which lists none of its own; before the agent says, a line saying so. A press on a tool
// says all of it in the status bar. Switched off, there is no tab.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { NoStateFile } from "@lightstart/kernel/settings.ts";
import { openWorkspace } from "@lightstart/workspace/workspace.ts";
import { composeWidecode, Widecode } from "../src/compose.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";

/** The Available tab's rows at 40 cells, its info line first, joined with | ("none" when there is no tab); spaces between words folded to two. */
const tab = (w: Widecode): string => {
  const p = w.host.screen.findPanel("available");
  if (p === null) return "none";
  const s = p.view.source;
  s.prepare(40);
  const out: string[] = [p.info().map((r: Run) => r.text).join("")];
  for (let i = 0; i < s.count(); i++) out.push(s.line(i, 40).runs.map((r: Run) => r.text).join("").replace(/\s+$/, "").replace(/(\S) {2,}(\S)/g, "$1  $2"));
  return out.join("|");
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-available-"));
  const fake = join(process.cwd(), "test/fake-acp.mjs");
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  const config: unknown = {
    acp: {
      agents: {
        fake: { name: "Fake", command: ["node", fake], tools: ["node", fake, "--tools", "{mode}"] },
        old: { name: "Old", command: ["node", fake, "--legacy"] },
      },
    },
  };
  w.start(config, new NoStateFile(), []);
  await w.host.load();
  eq("before the agent says", tab(w), " 0 tools|   Known once Claude starts.");

  // Claude Code: its init record.
  c.receive(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s-1",
      model: "claude-haiku-4-5",
      cwd: folder,
      tools: ["Bash", "Read", "mcp__claude_ai_Claude_Docs__query", "mcp__claude_ai_Claude_Docs__read", "mcp__gone__ping"],
      mcp_servers: [
        { name: "claude.ai Claude Docs", status: "connected" },
        { name: "broken", status: "failed" },
      ],
    }),
  );
  const claude = "Claude|   Bash|   Read| claude.ai Claude Docs  MCP|   query|   read| broken  MCP · failed| gone  MCP|   ping";
  ok("Claude Code's, from its init: its own, then each server's", await until(() => tab(w).endsWith(claude)));
  eq("and how many", tab(w).split("|")[0], " 5 tools");
  c.receive(
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m1",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "t2", name: "mcp__claude_ai_Claude_Docs__query", input: { q: "x" } },
          { type: "tool_use", id: "t3", name: "Bash", input: { command: "pwd" } },
        ],
      },
    }),
  );
  ok("its calls counted, an MCP tool's by its whole name, the programs its commands ran after them", await until(() => tab(w).endsWith("Claude|   Bash  ×2|   Read| claude.ai Claude Docs  MCP|   query  ×1|   read| broken  MCP · failed| gone  MCP|   ping| Programs|   ls  ×1|   pwd  ×1")));
  eq("and how many were used", tab(w).split("|")[0], " 5 tools · 2 used");
  eq("as the model keeps them", c.model.available.map((t) => (t.server.length > 0 ? t.server + "/" : "") + t.name).join(",") + " " + c.model.servers.map((s) => s.name + ":" + s.status).join(","), "Bash,Read,claude.ai Claude Docs/query,claude.ai Claude Docs/read,gone/ping claude.ai Claude Docs:connected,broken:failed");

  // An ACP agent: its tools command for its mode, with widecode's own tools.
  eq("an ACP agent", w.host.session.useAgent("fake"), "");
  c.reset();
  ok("not said yet", await until(() => tab(w) === " 0 tools|   Known once Fake starts."));
  w.host.roles.chat.submit("hello");
  const build = "Fake|   bash|   read|   edit|   write|   glob| widecode  MCP|   AskUser|   PresentPlan|   screen|   state|   log|   reload|   api|   check|   config";
  ok("its own from its tools command, then widecode's", await until(() => tab(w).endsWith(build)));
  eq("and how many", tab(w).split("|")[0], " 14 tools");
  w.host.roles.chat.submit("/plan");
  const plan = "Fake|   bash  asks|   read|   edit  only .opencode/plans/*.md|   write  only .opencode/plans/*.md|   glob  denied| widecode  MCP|   AskUser|   PresentPlan|   screen|   state|   log|   reload|   api|   check|   config";
  ok("read again for another mode: what its rules deny, limit or ask for", await until(() => tab(w).endsWith(plan)));
  const p = w.host.screen.findPanel("available");
  if (p !== null) p.press(3, 0);
  eq("a press on one says all of it", w.host.screen.message.peek(), "edit (Fake): only .opencode/plans/*.md");
  w.host.roles.chat.submit("question");
  await until(() => w.chat.pane.panel.active);
  w.chat.pane.panel.key(new KeyEvent("char", "1", false, false, false), true);
  ok("a call of widecode's tool, counted", await until(() => tab(w).endsWith("|   AskUser  ×1|   PresentPlan|   screen|   state|   log|   reload|   api|   check|   config") && tab(w).split("|")[0] === " 14 tools · 1 used"));

  // One with no tools command (and no MCP over HTTP).
  eq("another", w.host.session.useAgent("old"), "");
  c.reset();
  w.host.roles.chat.submit("hello");
  ok("it lists none of its own", await until(() => tab(w) === " 0 tools| Old  lists none of its own"));
  w.host.kernel.stop();
  w.js.killProcesses();

  const c2 = new Conversation(ws.folder);
  const w2 = composeWidecode(ws, c2);
  const off: unknown = { tools: false };
  w2.start(off, new NoStateFile(), []);
  await w2.host.load();
  eq("switched off: no tab", tab(w2), "none");
  w2.host.kernel.stop();

  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
