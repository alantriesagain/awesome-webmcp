// ffi: @lightstart/plugins/native/ffi.json
// The Tools tab of the tools column, from a recorded turn where a message came in while a tool ran:
// the calls under the message each answers, the one sent meanwhile between them; a running call
// with a spinner and its clock, a finished one with ● and its time; the count and the link's badge.
// ↓ selects a call, Enter (or a press) shows it whole in the code column, its command and output,
// Esc goes back to the file; reveal selects a call from elsewhere. From a transcript, a call's time
// comes from its records' timestamps; a call with no result when the turn ended is stopped.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText, projectDir, rec, str } from "./support/claude-records.ts";
import { callMs, callState, findCall } from "../src/conversation/calls.ts";
import { span } from "@lightstart/tui/duration.ts";
import { closeLightcode, openLightcode } from "./support/app.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";

interface Frame {
  dir?: unknown;
  raw?: unknown;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "lightcode-tools-"));
  writeFileSync(join(folder, "a.txt"), "a\n");
  // Claude Code's sessions for the folder, under a projects folder of the test's own.
  const projects = join(folder, ".projects");
  const config: unknown = { claude: { projects } };
  const w = await openLightcode({ folder, plugins: config, load: true });
  const c = w.host.conversation;
  await w.code.load("a.txt");
  const panel = w.tools.panel;
  if (panel === null) {
    ok("the tools plugin mounted the Tools tab", false);
    done();
    return;
  }
  const rows = (): string[] => {
    const s = panel.source;
    s.prepare(60);
    const out: string[] = [];
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 60).runs.map((r: Run) => r.text).join("").replace(/\s+$/, ""));
    return out;
  };
  const press = (name: string): boolean => w.shell.handleKey(new KeyEvent(name, "", false, false, false));

  let running: string[] = [];
  for (const line of readFileSync(join(process.cwd(), "test", "fixtures", "midtool.ndjson"), "utf8").split("\n")) {
    if (line.length === 0) continue;
    const f = JSON.parse(line) as Frame;
    if (typeof f.raw !== "string") continue;
    const r = rec(JSON.parse(f.raw));
    if (f.dir === "in") {
      const m = r !== null ? rec(r.message) : null;
      if (r !== null && str(r.type) === "user" && m !== null) c.model.send(contentText(m.content).text, 0);
      continue;
    }
    c.receive(f.raw);
    w.host.conversation.changed();
    if (running.length === 0 && rows().some((l) => l.includes("Sleep for 6 seconds"))) running = rows();
  }
  const runningRow = running.find((l) => l.includes("Sleep for 6 seconds")) ?? "";
  ok("a running call: a spinner, its tool and what its command does, its clock", SPINNER.includes(runningRow.trim()[0]) && /Bash Sleep for 6 seconds then echo STEP-ONE +\d+\.\ds$/.test(runningRow));
  const all = rows();
  eq(
    "the calls under the message each answers, the one sent meanwhile between them",
    all.map((l) => l.replace(/ +\d+\.\ds$/, "").replace(/\s+$/, "")).join(" | "),
    " › Run the shell command `sleep 6; echo STEP-ONE` with the… |    ● Bash Sleep for 6 seconds then echo STEP-ONE |  |  › Also, at the end, say the word BANANA. |    ● Bash Echo STEP-TWO",
  );
  ok("finished, each with its time", all.filter((l) => /● Bash .* \d+\.\ds$/.test(l)).length === 2);
  eq("the count, and the link's badge", panel.info().map((r: Run) => r.text).join("") + " / " + panel.badge().map((r: Run) => r.text).join(""), " 2 calls / 2");
  ok("the tools column shows the Tools tab first", w.host.screen.shownIn("tools") === "calls");
  eq("a seventh of the terminal, 32 to 44 cells, the Agents tab's too", [200, 260, 330].map((cols) => String(panel.width(cols)) + "/" + String(w.host.screen.findPanel("agents")?.width(cols) ?? 0)).join(" "), "32/32 37/37 44/44");

  w.host.screen.focus("tools");
  press("down");
  press("down");
  ok("↓ selects the calls in turn", panel.source.selected === 4);
  press("enter");
  ok("Enter shows the call in a tab beside Code", w.host.roles.code.inAgent() && w.code.tabs.active().title === "Bash" && w.code.tabs.active().id === (panel.source.rows[panel.source.selected].item?.id ?? ""));
  const view = w.code.shownPane().view;
  view.source.prepare(80);
  const page: string[] = [];
  for (let i = 0; i < view.source.count(); i++) page.push(view.source.line(i, 80).runs.map((r: Run) => r.text).join(""));
  ok("its line, where it stands and for how long", page[0].startsWith("● Bash Echo STEP-TWO") && /^ {2}done · \d+\.\ds$/.test(page[1]));
  ok("its command whole and its output", page.some((l) => l.includes("⎿ echo STEP-TWO")) && page.some((l) => l.includes("STEP-TWO") && !l.includes("echo")));
  w.host.screen.focus("code");
  press("escape");
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 100);
  });
  ok("Esc closes the call tab and shows the file", !w.host.roles.code.inAgent() && w.code.tabs.active().id === "code" && w.host.roles.code.path() === "a.txt");

  const first = findCall(c.model, panel.source.rows[1].item?.id ?? "");
  w.host.screen.showPanel("agents");
  if (first !== null) w.host.roles.tools.reveal(first.id);
  ok("reveal shows the Tools tab with the call selected", w.host.screen.shownIn("tools") === "calls" && panel.source.selected === 1);
  w.host.screen.focus("tools");
  press("tab");
  const next = w.host.screen.shownIn("tools");
  press("tab");
  eq("Tab in the tools column: the Available tab, then the Agents tab", next + " " + w.host.screen.shownIn("tools"), "available agents");

  // A transcript resumed: the times come from the records; a call with no result when the turn ends is stopped.
  const t = (o: unknown): string => JSON.stringify(o);
  const records: string[] = [
    t({ type: "user", uuid: "u1", timestamp: "2026-10-15T10:00:00.000Z", message: { role: "user", content: "go" } }),
    t({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-10-15T10:00:01.000Z", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } }] } }),
    t({ type: "user", uuid: "r1", parentUuid: "a1", timestamp: "2026-10-15T10:00:03.500Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "built" }] } }),
    t({ type: "assistant", uuid: "a2", parentUuid: "r1", timestamp: "2026-10-15T10:00:04.000Z", message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "make test" } }] } }),
  ];
  mkdirSync(projectDir(projects, folder), { recursive: true });
  writeFileSync(join(projectDir(projects, folder), "s1.jsonl"), records.join("\n") + "\n");
  c.resume("s1", "");
  const made = findCall(c.model, "t1");
  const cut = findCall(c.model, "t2");
  eq("from the records' times", made !== null ? callState(made) + " " + span(callMs(made, 0)) : "", "done 2.5s");
  eq("no result when its turn ended: stopped", cut !== null ? callState(cut) : "", "stopped");
  eq("past a minute, minutes and seconds", span(125000), "2m 05s");

  closeLightcode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
