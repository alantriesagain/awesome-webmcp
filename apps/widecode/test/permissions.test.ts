// ffi: @light/plugins/native/ffi.json
// Tool permissions: the rules the user's and the project's config.json hold, in Claude Code's
// syntax, merged (the user's first, the project's ask and deny added, its allow left out); a
// can_use_tool the CLI sends for an ordinary tool is a permission the request panel puts to the user
// (Allow once, Allow for this session, Allow all for this session, Deny): the recorded control
// responses, byte for byte against the fake CLI in strict mode, a call allowed for the session
// answered without the panel, a denial with its message. Allow all, in plan mode: the prompt open
// beside it allowed and shown as answered, every later one allowed without the panel, until /new. A prompt about a path outside the session's folders offers the git repository
// holding it, for the session (added again to each start with --add-dir) or from now on (kept by
// the CLI in the project's local settings).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { mergePermissions } from "../src/services/harness.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { createWidecode } from "../src/compose.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

const fixtures = join(process.cwd(), "test", "fixtures");
const fake = join(process.cwd(), "test", "fake-claude.mjs");

const main = async (): Promise<void> => {
  const both = mergePermissions({ allow: ["Bash(npm test *)"], ask: ["Bash(git push *)"], deny: ["Read(./.env)"] }, { allow: ["Bash"], ask: ["Bash(git push *)", "WebFetch"], deny: ["Bash(rm -rf *)"] });
  eq("the user's rules first, the project's ask and deny added once, its allow left out", both.rulesJson() + " | " + both.notice, '{"allow":["Bash(npm test *)"],"ask":["Bash(git push *)","WebFetch"],"deny":["Read(./.env)","Bash(rm -rf *)"]} | the project\'s permissions.allow is not used: a project adds ask and deny rules only');
  const alone = mergePermissions(null, { deny: ["Bash(rm -rf *)", "", 3] });
  eq("a side alone, strings alone", alone.rulesJson() + " " + String(alone.any()) + " " + alone.notice, '{"allow":[],"ask":[],"deny":["Bash(rm -rf *)"]} true ');
  eq("nothing set", mergePermissions(null, null).rulesJson() + " " + String(mergePermissions({ ask: "Bash" }, 7).any()), '{"allow":[],"ask":[],"deny":[]} false');

  const folder = mkdtempSync(join(tmpdir(), "widecode-permissions-"));
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  c.executable = fake;
  c.extraArgs.push("--fixture", join(fixtures, "permission.ndjson"), "--strict");
  const written: string[] = [];
  c.onWrite = (line: string) => written.push(line);
  const logs: string[] = [];
  const w = createWidecode(ws, c, null);
  w.host.onLog = (text: string) => logs.push(text);
  const panel = w.chat.pane.panel;
  const open = (): string => c.model.openRequests().map((r) => r.requestId).join(",");
  const responded = (rid: string, text: string): boolean => written.some((l) => l.includes('"request_id":"' + rid + '"') && l.includes(text));

  c.send("go", []);
  ok("a tool the CLI asks about waits in the request panel", await until(() => open() === "req-1" && panel.active, 10000));
  const r1 = c.model.openRequests()[0];
  const q1 = r1.questions[0];
  eq("as a permission: the tool and its argument, the three answers", [r1.category, r1.name, q1.header, q1.question, q1.options.map((o) => o.label).join(",")].join(" | "), "permission | Bash | Permission | Bash git push origin main: allow it? | Allow once,Allow for this session,Allow all for this session,Deny");
  panel.key(new KeyEvent("char", "1", false, false, false), true);
  ok("allowed once: the CLI gets allow with the call's own input", await until(() => responded("req-1", '"behavior":"allow","updatedInput":{"command":"git push origin main","description":"Push the branch"}'), 5000) && logs.some((l) => l === "claude: Bash allowed by the user"));
  ok("the same call asks again", await until(() => open() === "req-2" && panel.active, 5000));
  panel.key(new KeyEvent("char", "2", false, false, false), true);
  ok("allowed for the session: the CLI gets allow", await until(() => responded("req-2", '"behavior":"allow"'), 5000) && logs.some((l) => l === "claude: Bash allowed by the user for this session"));
  ok("the third, the same call, is allowed without the panel", await until(() => responded("req-3", '"behavior":"allow"'), 5000) && logs.some((l) => l === "claude: allowed Bash again (allowed for this session)"));
  ok("another command asks", await until(() => open() === "req-4" && panel.active, 5000) && c.model.openRequests()[0].questions[0].question === "Bash rm -rf build: allow it?");
  panel.key(new KeyEvent("char", "4", false, false, false), true);
  ok("denied: the CLI gets deny with a message", await until(() => responded("req-4", '"behavior":"deny","message":"The user denied Bash"'), 5000) && logs.some((l) => l === "claude: Bash denied by the user"));
  ok("the turn ends", await until(() => !c.model.running && c.model.turns.some((t) => t.result !== null), 10000));
  c.stop();
  ok("the fake saw every response as recorded, byte for byte, and exited 0", await until(() => logs.includes("claude exited with code 0"), 8000));

  const repo = mkdtempSync(join(tmpdir(), "widecode-outside-"));
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  const kept = mkdtempSync(join(tmpdir(), "widecode-kept-"));
  mkdirSync(join(kept, ".git"));
  const deep = join(repo, "src", "deep");
  const listInput = { command: "cd " + deep + " && ls", description: "List" };
  const readInput = { file_path: join(kept, "notes.txt") };
  const allowed = (rid: string, input: unknown, dir: string, destination: string): unknown => ({ type: "control_response", response: { subtype: "success", request_id: rid, response: { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "addDirectories", directories: [dir], destination }] } } });
  const outside = join(folder, "outside.ndjson");
  const line = (dir: string, value: unknown): string => JSON.stringify({ dir, raw: JSON.stringify(value) });
  const recorded = [
    line("out", { type: "system", subtype: "init", cwd: folder, session_id: "22222222-3333-4444-5555-666666666666", tools: ["Bash", "Read"], model: "fake", permissionMode: "default" }),
    line("in", { type: "user" }),
    line("out", { type: "control_request", request_id: "req-5", request: { subtype: "can_use_tool", tool_name: "Bash", input: listInput, blocked_path: deep, tool_use_id: "toolu_5" } }),
    line("in", allowed("req-5", listInput, repo, "session")),
    line("out", { type: "control_request", request_id: "req-6", request: { subtype: "can_use_tool", tool_name: "Read", input: readInput, decision_reason: "Path is outside allowed working directories", decision_reason_type: "workingDir", tool_use_id: "toolu_6" } }),
    line("in", allowed("req-6", readInput, kept, "localSettings")),
    line("out", { type: "result", subtype: "success", is_error: false, session_id: "22222222-3333-4444-5555-666666666666", result: "done" }),
  ];
  writeFileSync(outside, recorded.join("\n") + "\n");
  c.extraArgs.splice(0, c.extraArgs.length, "--fixture", outside, "--strict");
  logs.length = 0;
  c.send("look outside", []);
  ok("a call outside the session's folders waits in the request panel", await until(() => open() === "req-5" && panel.active, 10000));
  eq("it offers the git repository holding the path, for the session or from now on", c.model.openRequests()[0].questions[0].options.map((o) => o.label).join(","), "Allow once,Allow for this session,Allow " + repo + " for this session,Allow " + repo + " from now on,Allow all for this session,Deny");
  panel.key(new KeyEvent("char", "3", false, false, false), true);
  ok("the folder for the session: allow, and the folder added for the session", await until(() => responded("req-5", '"destination":"session"'), 5000) && logs.some((l) => l === "claude: Bash allowed by the user, and " + repo + " for this session"));
  ok("a read the CLI says is outside offers its repository", await until(() => open() === "req-6" && panel.active, 5000) && c.model.openRequests()[0].questions[0].options[3].label === "Allow " + kept + " from now on");
  panel.key(new KeyEvent("char", "4", false, false, false), true);
  ok("the folder from now on: kept in the project's local settings", await until(() => responded("req-6", '"destination":"localSettings"'), 5000));
  ok("the turn ends and the fake exits 0", await until(() => !c.model.running, 10000) && (c.stop(), await until(() => logs.includes("claude exited with code 0"), 8000)));
  const args = join(folder, "args.txt");
  c.extraArgs.splice(0, c.extraArgs.length, "--fixture", join(fixtures, "turn.ndjson"), "--record-args", args);
  c.send("again", []);
  ok("the next start adds the session's folder again, and leaves the kept one to the settings", await until(() => { try { const a = readFileSync(args, "utf8"); return a.includes("--add-dir\n" + repo + "\n") && !a.includes(kept); } catch { return false; } }, 10000));
  ok("that turn ends", await until(() => !c.model.running, 10000));
  c.stop();
  ok("and its fake exits 0", await until(() => logs.filter((l) => l === "claude exited with code 0").length === 2, 8000));

  // Allow all, in plan mode (every Bash call asks there): two prompts open together, then one more.
  const bash = (rid: string, input: unknown): unknown => ({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: "Bash", input, tool_use_id: "toolu_" + rid } });
  const allowedAs = (rid: string, input: unknown): unknown => ({ type: "control_response", response: { subtype: "success", request_id: rid, response: { behavior: "allow", updatedInput: input } } });
  const lsInput = { command: "ls", description: "List" };
  const catInput = { command: "cat README.md", description: "Read" };
  const sedInput = { command: "sed -n 1,10p a.txt", description: "Head" };
  const planned = { type: "result", subtype: "success", is_error: false, session_id: "33333333-4444-5555-6666-777777777777", result: "done" };
  const all = join(folder, "all.ndjson");
  writeFileSync(all, [
    line("out", { type: "system", subtype: "init", cwd: folder, session_id: "33333333-4444-5555-6666-777777777777", tools: ["Bash"], model: "fake", permissionMode: "plan" }),
    line("in", { type: "user" }),
    line("out", bash("req-7", lsInput)),
    line("out", bash("req-8", catInput)),
    line("in", allowedAs("req-7", lsInput)),
    line("in", allowedAs("req-8", catInput)),
    line("out", bash("req-9", sedInput)),
    line("in", allowedAs("req-9", sedInput)),
    line("out", planned),
  ].join("\n") + "\n");
  c.extraArgs.splice(0, c.extraArgs.length, "--fixture", all, "--strict");
  logs.length = 0;
  c.send("plan it", []);
  ok("two prompts asked together wait in the panel", await until(() => open() === "req-7,req-8" && panel.active, 10000));
  const beside = c.model.openRequests()[1];
  eq("Allow all comes before Deny", c.model.openRequests()[0].questions[0].options.map((o) => o.label).join(","), "Allow once,Allow for this session,Allow all for this session,Deny");
  panel.key(new KeyEvent("char", "3", false, false, false), true);
  ok("allow all: the call allowed, and the one beside it, shown as answered", await until(() => responded("req-7", '"behavior":"allow"') && responded("req-8", '"behavior":"allow"') && open() === "", 5000) && beside.state === "answered" && logs.some((l) => l === "claude: Bash allowed by the user, and every call after it for this session"));
  ok("a later prompt is allowed without the panel", await until(() => responded("req-9", '"behavior":"allow"'), 5000) && logs.some((l) => l === "claude: allowed Bash (all allowed for this session)") && open() === "");
  ok("the turn ends and the fake exits 0", await until(() => !c.model.running, 10000) && (c.stop(), await until(() => logs.includes("claude exited with code 0"), 8000)));

  // /new ends it: the next prompt asks again.
  const again = join(folder, "again.ndjson");
  writeFileSync(again, [
    line("out", { type: "system", subtype: "init", cwd: folder, session_id: "44444444-5555-6666-7777-888888888888", tools: ["Bash"], model: "fake", permissionMode: "plan" }),
    line("in", { type: "user" }),
    line("out", bash("req-10", lsInput)),
    line("in", { type: "control_response", response: { subtype: "success", request_id: "req-10", response: { behavior: "deny", message: "The user denied Bash" } } }),
    line("out", { type: "result", subtype: "success", is_error: false, session_id: "44444444-5555-6666-7777-888888888888", result: "done" }),
  ].join("\n") + "\n");
  w.host.kernel.commands.run("/new");
  c.extraArgs.splice(0, c.extraArgs.length, "--fixture", again, "--strict");
  logs.length = 0;
  c.send("plan again", []);
  ok("after /new a prompt waits in the panel again", await until(() => open() === "req-10" && panel.active, 10000));
  panel.key(new KeyEvent("char", "4", false, false, false), true);
  ok("denied, the turn ends and the fake exits 0", await until(() => responded("req-10", '"behavior":"deny"') && !c.model.running, 10000) && (c.stop(), await until(() => logs.includes("claude exited with code 0"), 8000)));
  rmSync(repo, { recursive: true, force: true });
  rmSync(kept, { recursive: true, force: true });
  w.host.kernel.stop();
  w.js.killProcesses();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
