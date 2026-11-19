// ffi: @lightstart/plugins/native/ffi.json
// Claude Code follows the session's approval mode: the start command's --permission-mode (its
// prompts still come over stdio), a mode changed while the CLI runs sent with set_permission_mode,
// and a can_use_tool prompt answered by the mode without the request panel (allowed in Full access,
// denied in plan, a read inside the folder allowed in auto).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Widecode } from "../src/compose.ts";
import { openWidecode } from "./support/app.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";

const fixtures = join(process.cwd(), "test", "fixtures");
const fake = join(process.cwd(), "test", "fake-claude.mjs");

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-claude-approval-"));
  const args = join(folder, "args.txt");
  const logs: string[] = [];
  const w = await openWidecode({
    folder,
    before: (w: Widecode) => {
      w.host.conversation.executable = fake;
      w.host.conversation.extraArgs.push("--fixture", join(fixtures, "turn.ndjson"), "--record-args", args);
    },
  });
  const c = w.host.conversation;
  w.host.onLog = (text: string) => logs.push(text);
  await w.host.session.load(w.host.folder, w.host.hooks);

  const argsOf = (): string[] => {
    try {
      return readFileSync(args, "utf8").split("\n");
    } catch {
      return [];
    }
  };
  const started: string[] = [];
  for (const mode of ["ask", "auto", "plan", "full"]) {
    w.host.approval.set(mode);
    rmSync(args, { force: true });
    c.send("go", []);
    ok("the CLI starts in " + mode, await until(() => argsOf().includes("--permission-mode"), 10000));
    const a = argsOf();
    const at = a.indexOf("--permission-mode");
    const tool = a.indexOf("--permission-prompt-tool");
    started.push([mode, a[at + 1], tool >= 0 ? a[tool + 1] : ""].join(":"));
    c.stop();
    ok("and stops in " + mode, await until(() => !c.started, 10000));
  }
  eq("each approval mode maps to Claude Code's, its prompts coming over stdio", started.join(","), "ask:default:stdio,auto:acceptEdits:stdio,plan:plan:stdio,full:bypassPermissions:stdio");

  const written: string[] = [];
  c.onWrite = (line: string) => written.push(line);
  w.host.approval.set("ask");
  c.send("go", []);
  ok("the CLI runs for the live change", await until(() => c.started, 10000));
  w.host.approval.set("auto");
  ok("auto reaches the running CLI as acceptEdits", await until(() => written.some((l) => l.includes('"set_permission_mode"') && l.includes('"mode":"acceptEdits"')), 3000));
  w.host.approval.set("full");
  ok("full reaches it as bypassPermissions", await until(() => written.some((l) => l.includes('"set_permission_mode"') && l.includes('"mode":"bypassPermissions"')), 3000));

  c.stop();
  ok("the live run stops", await until(() => !c.started, 10000));

  // Prompts the mode answers: the fake checks each response byte for byte.
  const line = (dir: string, value: unknown): string => JSON.stringify({ dir, raw: JSON.stringify(value) });
  const asks = (rid: string, tool: string, input: unknown): unknown => ({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: tool, input, tool_use_id: "toolu_" + rid } });
  const allowed = (rid: string, input: unknown): unknown => ({ type: "control_response", response: { subtype: "success", request_id: rid, response: { behavior: "allow", updatedInput: input } } });
  const denied = (rid: string): unknown => ({ type: "control_response", response: { subtype: "success", request_id: rid, response: { behavior: "deny", message: "plan mode: nothing changes" } } });
  const answered = async (mode: string, rid: string, tool: string, input: unknown, answer: unknown, said: string): Promise<boolean> => {
    const fixture = join(folder, mode + ".ndjson");
    writeFileSync(fixture, [
      line("out", { type: "system", subtype: "init", cwd: folder, session_id: "55555555-6666-7777-8888-99999999999" + String(rid.length), tools: [tool], model: "fake", permissionMode: "default" }),
      line("in", { type: "user" }),
      line("out", asks(rid, tool, input)),
      line("in", answer),
      line("out", { type: "result", subtype: "success", is_error: false, session_id: "55555555-6666-7777-8888-99999999999" + String(rid.length), result: "done" }),
    ].join("\n") + "\n");
    w.host.approval.set(mode);
    c.extraArgs.splice(0, c.extraArgs.length, "--fixture", fixture, "--strict");
    logs.length = 0;
    c.send("go", []);
    // The fake runs strict: a response that differs from the recorded one makes it exit with an error.
    const decided = await until(() => logs.includes(said), 10000);
    c.stop();
    const exited = await until(() => !c.started && logs.some((l) => l.startsWith("claude exited")), 8000);
    return decided && exited && c.model.openRequests().length === 0 && !logs.some((l) => /exited with code [1-9]/.test(l));
  };
  const read = { file_path: folder + "/a.txt" };
  ok("Full access: a command is allowed at once, without the panel", await answered("full", "r1", "Bash", { command: "ls" }, allowed("r1", { command: "ls" }), "claude: Bash allowed by mode full"));
  ok("plan: a write is denied at once", await answered("plan", "r2", "Write", read, denied("r2"), "claude: Write rejected by mode plan"));
  ok("auto: a read inside the folder is allowed without asking", await answered("auto", "r3", "Read", read, allowed("r3", read), "claude: Read allowed by mode auto"));

  w.host.workspace.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
