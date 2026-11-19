// ffi: @lightstart/plugins/native/ffi.json
// The skills the agent has, in the Skills tab of the files column (plugins/skills/index.ts): Claude
// Code's from disk before it starts (the project's, with its SKILL.md's description), then from its
// init record (a plugin's under the plugin's path, a bundled one by name alone), each a command the
// composer completes; a Skill call
// starts a run that counts the turn's calls and ends with the turn, a skill the user typed too; a
// press on a skill shows its file in the code column (a project's as a file, another's text as a
// view) and puts its command in the composer, `v` goes to the file. An ACP agent's skills come from its entry's skills command
// (test/fake-acp.mjs --skills, as opencode's `debug skill`), called in words, so no command of
// theirs is registered (Claude Code's are dropped); its skill tool's call is a run. A run that
// ended is kept in the folder's records (`.widecode/skills.jsonl`): a row says this session's runs
// and the project's across sessions and agents, a press says how many were typed and chosen. One
// with no skills command lists none. Switched off, there is no tab.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Widecode } from "../src/compose.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { Store } from "../src/services/store.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { KeyEvent, setValue } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until, wait } from "@lightstart/test/headless.ts";

/** The Skills tab's rows at 60 cells, its info line first, joined with | ("none" when there is no tab); spaces between words folded to two, a clock to T. */
const tab = (w: Widecode): string => {
  const p = w.host.screen.findPanel("skills");
  if (p === null) return "none";
  const s = p.view.source;
  s.prepare(60);
  const out: string[] = [p.info().map((r: Run) => r.text).join("")];
  for (let i = 0; i < s.count(); i++) out.push(s.line(i, 60).runs.map((r: Run) => r.text).join("").replace(/\s+$/, "").replace(/(\S) {2,}(\S)/g, "$1  $2"));
  return out.join("|").replace(/ · \d+[smh][0-9a-z]*/g, " · T");
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-skills-"));
  mkdirSync(join(folder, ".claude", "skills", "alpha"), { recursive: true });
  writeFileSync(join(folder, ".claude", "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: The first skill.\n---\n\n# Alpha\n\nDo the alpha thing.\n");
  const plugin = mkdtempSync(join(tmpdir(), "widecode-skills-plugin-"));
  mkdirSync(join(plugin, "skills", "gamma"), { recursive: true });
  writeFileSync(join(plugin, "skills", "gamma", "SKILL.md"), "---\nname: gamma\ndescription: |\n  Multi line.\n  Said twice.\n---\n# Gamma\n");
  const fake = join(process.cwd(), "test/fake-acp.mjs");
  // Claude Code's config folder, empty: no user skills of this machine's in the list.
  const configDir = mkdtempSync(join(tmpdir(), "widecode-skills-config-"));
  const config: unknown = {
    claude: { configDir },
    acp: {
      agents: {
        fake: { name: "Fake", command: ["node", fake], skills: ["node", fake, "--skills"] },
        old: { name: "Old", command: ["node", fake, "--legacy"] },
      },
    },
  };
  const w = await openWidecode({ folder, plugins: config });
  const c = w.host.conversation;
  // A store: the folder's records keep the skill runs.
  const home = mkdtempSync(join(tmpdir(), "widecode-skills-home-"));
  await w.host.session.useStore(new Store(home));
  // Trusted, as the app marks a folder it works in: the project's skills count.
  w.host.session.setTrusted(true);
  await w.host.session.load(w.host.folder, w.host.hooks);
  const onDisk = " 1 skill| project|   alpha  The first skill.|   More once Claude starts.";
  await until(() => tab(w) === onDisk);
  eq("before Claude says: the project's skill, read from disk, with more to come", tab(w), onDisk);
  const early = w.host.kernel.commands.find("/alpha");
  eq("already a command", early !== null ? early.help : "none", "The first skill.");

  // Claude Code: its init record names the skills and the plugins.
  c.receive(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", model: "claude-haiku-4-5", cwd: folder, tools: ["Bash", "Skill"], skills: ["alpha", "beta", "mp:gamma"], plugins: [{ name: "mp", path: plugin, source: "mp@test" }, { name: "agents-md", path: "builtin", source: "agents-md@builtin" }] }));
  const listed = " 3 skills| project|   alpha  The first skill.| mp|   mp:gamma  Multi line. Said twice.| built-in|   beta";
  await until(() => tab(w) === listed);
  eq("Claude Code's, by source: the project's with its description, a plugin's from the plugin's path, a bundled one by name", tab(w), listed);
  const alpha = w.host.kernel.commands.find("/alpha");
  eq("each is a command, its description the help", (alpha !== null ? alpha.help + " " + alpha.owner : "none") + " · " + String(w.host.kernel.commands.find("/mp:gamma") !== null) + " " + String(w.host.kernel.commands.find("/beta") !== null), "The first skill. skills · true true");
  const compact = w.host.kernel.commands.find("/compact");
  eq("the chat's own command is left alone", compact !== null ? compact.owner : "none", "chat");

  w.host.screen.showPanel("skills");
  const p = w.host.screen.findPanel("skills");
  /** The code column's view as text, its lines joined with |. */
  const shown = (): string => {
    const view = w.code.pane.view;
    view.source.prepare(80);
    const out: string[] = [];
    for (let i = 0; i < view.source.count(); i++) out.push(view.source.line(i, 80).runs.map((r: Run) => r.text).join("").trimEnd());
    return out.join("|");
  };
  if (p !== null) p.press(1, 0);
  await wait(100);
  eq("a press on a skill shows its SKILL.md rendered in the code column, without its frontmatter, and puts its command in the composer, which keeps the focus", w.code.pane.agent.peek() + " · " + shown() + " · " + w.chat.pane.input.value() + " · " + w.host.screen.active.peek(), "alpha · .claude/skills/alpha/SKILL.md ·  Alpha|| Do the alpha thing. · /alpha  · chat");
  w.host.screen.focus("side");
  w.shell.handleKey(new KeyEvent("char", "v", false, false, false));
  await wait(50);
  eq("v goes to the file", w.host.screen.active.peek(), "code");
  w.host.screen.focus("side");
  w.shell.handleKey(new KeyEvent("down", "", false, false, false));
  w.shell.handleKey(new KeyEvent("char", "v", false, false, false));
  await wait(50);
  eq("the plugin's, outside the folder, rendered too", w.code.pane.agent.peek() + " · " + shown(), "mp:gamma · " + plugin + "/skills/gamma/SKILL.md ·  Gamma");

  // A Skill call starts a run; the turn's calls after it count; the turn's end ends it.
  c.receive(JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "alpha", args: "" } }] } }));
  c.receive(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "# Alpha\n\nDo the alpha thing." }] } }));
  ok("the run, in progress with the turn", await until(() => tab(w).startsWith(" 3 skills · 1 run · 1 running| Runs  1 running| ● alpha  running · 0 calls · T| project|   alpha  The first skill.  ×1|")));
  c.receive(JSON.stringify({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }] } }));
  c.receive(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "a.txt" }] } }));
  ok("the call after it counted", await until(() => tab(w).includes("| ● alpha  running · 1 call · T|")));
  c.receive(JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 1200, total_cost_usd: 0.01, result: "Done." }));
  ok("done with the turn", await until(() => tab(w).includes("| ● alpha  done · 1 call · T|") && tab(w).startsWith(" 3 skills · 1 run| Runs|")));
  eq("the badge counts the skills when none runs", p !== null ? p.badge().map((r: Run) => r.text).join("") : "", "3");
  /** The runs the folder's records keep: skill, typed or not, how it ended, the calls after it. */
  const keptRuns = (): string => {
    let text = "";
    try {
      text = readFileSync(join(folder, ".widecode", "skills.jsonl"), "utf8");
    } catch {
      return "";
    }
    const rows = new Map<string, string>();
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      const r = JSON.parse(line) as { id: string; skill: string; typed: boolean; state: string; calls: number; agent: string };
      rows.set(r.id, r.agent + ":" + r.skill + ":" + (r.typed ? "typed" : "chosen") + ":" + r.state + ":" + String(r.calls));
    }
    return [...rows.values()].join(" ");
  };
  ok("the ended run is kept in the project's records", await until(() => keptRuns() === "claude:alpha:chosen:done:1"));
  ok("its row says this session's runs and the project's", await until(() => tab(w).includes("|   alpha  The first skill.  ×1 · 1 run|")));

  // A skill the user typed: the message opens its turn, then Claude Code echoes the command.
  c.receive(JSON.stringify({ type: "user", message: { role: "user", content: "/beta now" } }));
  c.receive(JSON.stringify({ type: "user", isReplay: true, message: { role: "user", content: "<command-name>/beta</command-name>\n<command-message>beta</command-message>\n<command-args>now</command-args>" } }));
  const typed = " 3 skills · 2 runs · 1 running| Runs  1 running| ● beta  running · 0 calls · T · typed| ● alpha  done · 1 call · T|";
  await until(() => tab(w).startsWith(typed));
  eq("a typed skill is a run too, newest first", tab(w).slice(0, typed.length), typed);
  c.receive(JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 300, total_cost_usd: 0.01, result: "Ok." }));
  ok("ended with its turn", await until(() => tab(w).includes("| ● beta  done · 0 calls · T · typed|")));
  ok("kept too, as typed", await until(() => keptRuns() === "claude:alpha:chosen:done:1 claude:beta:typed:done:0"));
  const betaRow = tab(w).split("|").slice(1).findIndex((r: string) => r.startsWith("   beta"));
  if (p !== null) p.press(betaRow, 0);
  ok("a press on a skill says its runs in the project: typed, chosen, the last", w.host.screen.message.peek().includes(" · 1 run in this project · 1 typed · 0 chosen by the agent · last "));
  setValue(w.chat.pane.input, "");
  if (p !== null) p.press(1, 0);
  ok("a press on a typed run says what it was", w.host.screen.message.peek().startsWith("beta was typed as a command: done · 0 calls"));
  if (p !== null) p.press(2, 0);
  await wait(50);
  eq("a press on a call's run shows the call in the code column", String(w.host.roles.code.inAgent()) + " " + w.host.screen.active.peek(), "true code");

  // An ACP agent: its skills command, its skill tool.
  eq("an ACP agent", w.host.session.useAgent("fake"), "");
  c.reset();
  ok("not said yet", await until(() => tab(w) === " 0 skills|   Known once Fake starts."));
  w.host.roles.chat.submit("hello");
  // Its listing is over 64 KB, as opencode's is: read whole, through a file, natively too.
  ok("its skills from its command, a listing larger than a pipe holds: the folder's as the project's (with the run Claude Code made of it in this project), the built-in ones", await until(() => tab(w) === " 3 skills| project|   alpha  The first skill: use it when asked for alp… 1 run| built-in|   customize  Built into the agent.|   zeta  A skill with a long body."));
  eq("called in words: no command of theirs, and Claude Code's are gone", String(w.host.kernel.commands.find("/alpha")) + " " + String(w.host.kernel.commands.find("/beta")), "null null");
  const q = w.host.screen.findPanel("skills");
  if (q !== null) q.press(1, 0);
  eq("a press puts a sentence to finish in the composer", w.chat.pane.input.value(), "Use the alpha skill: ");
  if (q !== null) q.press(3, 0);
  eq("a built-in skill has no file: a page about it in the code column, the composer filled", w.code.pane.agent.peek() + " · " + shown() + " · " + w.chat.pane.input.value(), "customize · built into Fake ·  customize|| Built into Fake: no file to show.|| Built into the agent.|| Ask Fake for it in words. · Use the customize skill: ");
  setValue(w.chat.pane.input, "");
  w.host.roles.chat.submit("skill");
  ok("its skill tool's call is a run, done with the command after it, counted with the project's", await until(() => tab(w).startsWith(" 3 skills · 1 run| Runs| ● alpha  done · 1 call · T| project|   alpha  The first skill: use it when asked f… ×1 · 2 runs|")));
  ok("kept with the agent that ran it", await until(() => keptRuns().endsWith(" fake:alpha:chosen:done:1") && keptRuns().split(" ").length === 3));

  // One with no skills command.
  eq("another", w.host.session.useAgent("old"), "");
  c.reset();
  w.host.roles.chat.submit("hello");
  ok("it lists none", await until(() => tab(w) === " 0 skills| Old  lists no skills"));
  closeWidecode(w);

  const off: unknown = { skills: false };
  const w2 = await openWidecode({ folder, plugins: off, load: true });
  eq("switched off: no tab", tab(w2), "none");
  closeWidecode(w2);

  rmSync(folder, { recursive: true, force: true });
  rmSync(plugin, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
