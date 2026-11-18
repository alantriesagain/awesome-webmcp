// ffi: @lightstart/plugins/native/ffi.json
// The session's subagents, from a recorded turn where Claude ran one: the Agents tab lists it (its
// kind, its task, where it stands), its link's badge counts it; a press shows its steps in the code
// column (what it was told, its tool calls, what it handed back), Esc goes back to the file; the
// chat still draws the same steps nested under the call.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsOf, agentStatus } from "../src/conversation/agents.ts";
import { itemLines, RenderContext } from "../src/conversation/render.ts";
import { JsPanel } from "../src/runtime/views.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

interface Frame {
  dir?: unknown;
  raw?: unknown;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-agents-"));
  writeFileSync(join(folder, "a.txt"), "a\n");
  const w = await openWidecode({ folder, load: true });
  const c = w.host.conversation;
  await w.code.load("a.txt");
  for (const line of readFileSync(join(process.cwd(), "test", "fixtures", "subagent.ndjson"), "utf8").split("\n")) {
    if (line.length === 0) continue;
    const f = JSON.parse(line) as Frame;
    if (f.dir === "out" && typeof f.raw === "string") c.receive(f.raw);
  }
  w.host.session.conversationChanged.fire();
  const calls = agentsOf(c.model);
  eq("the turn's subagent, done", calls.map((a) => a.name + " " + agentStatus(a)).join(", "), "Agent done");

  w.host.screen.showPanel("agents");
  const tab = w.host.screen.findPanel("agents");
  const rows = tab instanceof JsPanel ? tab.rows : null;
  const text = (index: number): string => (rows !== null ? rows.line(index, 60).runs.map((r: Run) => r.text).join("") : "");
  eq("the Agents tab: its kind and task", text(0), " ● general-purpose Read notes.txt and report first line");
  ok("then where it stands and what it reported", text(1).startsWith("   done · "));
  eq("its link's badge counts it", tab !== null ? tab.badge().map((r: Run) => r.text).join("") : "", "1");

  if (tab !== null) tab.press(0, 3);
  await wait(50);
  const agentId = calls[0].id;
  ok("a press shows its steps in a tab beside Code", w.host.roles.code.inAgent() && w.code.tabs.active().id === agentId && w.host.screen.active.peek() === "code");
  eq("the tab's label is its type and its task, clipped", w.code.tabs.labels().join("|"), "Code|general-purpose: Read n… ×");
  w.host.roles.code.openAgent(agentId);
  eq("opening the same subagent twice keeps one tab", String(w.code.tabs.labels().length), "2");
  const steps: string[] = [];
  const view = w.code.shownPane().view;
  view.source.prepare(80);
  for (let i = 0; i < view.source.count(); i++) steps.push(view.source.line(i, 80).runs.map((r: Run) => r.text).join(""));
  ok("what it was told first, then its calls, flat", steps[0].startsWith("› ") && steps.some((l) => l.startsWith("● Read ")) && !steps.some((l) => l.startsWith("│ ")));
  ok("and what it handed back", steps.some((l) => l.startsWith("↳ handed back")));

  w.shell.handleKey(new KeyEvent("escape", "", false, false, false));
  await wait(100);
  eq("Esc closes the subagent tab and shows Code", w.code.tabs.active().id + " " + String(w.host.roles.code.inAgent()) + " " + w.host.roles.code.path(), "code false a.txt");

  c.receive(JSON.stringify({ type: "assistant", message: { id: "msg-tab-call", content: [{ type: "tool_use", id: "toolu_tab_call", name: "Bash", input: { command: "echo hi" } }] } }));
  w.host.session.conversationChanged.fire();
  w.host.roles.code.openAgent(agentId);
  w.host.roles.code.openCall("toolu_tab_call");
  eq("a call and a subagent: two tabs beside Code, the call shown", w.code.tabs.labels().join("|") + " " + w.code.tabs.active().id, "Code|general-purpose: Read n… ×|Bash × toolu_tab_call");
  w.shell.handleKey(new KeyEvent("escape", "", false, false, false));
  eq("closing the call shows the tab before it", w.code.tabs.active().id + " " + String(w.code.tabs.labels().length), agentId + " 2");
  w.shell.handleKey(new KeyEvent("escape", "", false, false, false));
  eq("then Esc closes the subagent and shows Code", w.code.tabs.active().id + " " + String(w.host.roles.code.inAgent()) + " " + w.host.roles.code.path(), "code false a.txt");

  const call = calls[0];
  call.expanded = true;
  c.model.touch(call);
  const nested = itemLines(call, new RenderContext(), [], 80).map((l) => l.runs.map((r: Run) => r.text).join(""));
  ok("the chat still draws its steps nested under the call", nested.some((l) => l.startsWith("│ ● Read ")));

  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
