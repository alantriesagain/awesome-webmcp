// ffi: @light/plugins/native/ffi.json
// Claude Code's sessions as its plugin lists them, on a synthetic projects folder: titles from the
// tail (the latest custom or AI title, found past the first tail window), the first real prompt
// from the head (slash-command echoes and meta records skipped), sessions of another folder left
// out, a 1 GB sparse file listed without reading it whole; and history windows (services/window.ts)
// over a 120 MB file walked back to the start at line boundaries (a 3 MB line grows its window; a
// line still being written is left out; bookkeeping records are dropped). A session resumed shows
// the subagent its Agent call ran, from the subagent's meta file, and says when another Claude runs
// it: a live process in Claude Code's records (sessions/<pid>.json) that widecode did not start.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { NOTICE, TOOL } from "@widecode/conversation/model.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { readAt, readWindow } from "@light/workspace/window.ts";
import { createWidecode } from "../src/compose.ts";
import { budget, done, eq, eqn, ok } from "@light/test/assert.ts";
import { projectDir } from "./support/claude-records.ts";

/** A session as the plugin lists it. */
interface Listed {
  id: string;
  title: string;
  firstPrompt: string;
  mtimeMs: number;
  size: number;
}

const main = async (): Promise<void> => {
const base = mkdtempSync(join(tmpdir(), "code-sessions-"));
const root = join(base, "projects");
const folder = "/home/someone/Projects/my_app.v2";
const dir = projectDir(root, folder);
mkdirSync(dir, { recursive: true });

const rec = (o: unknown): string => JSON.stringify(o) + "\n";
const user = (uuid: string, content: unknown, extra: string): string => {
  const base = '{"parentUuid":null,"isSidechain":false,"type":"user",' + extra + '"message":{"role":"user","content":' + JSON.stringify(content) + '},"uuid":' + JSON.stringify(uuid) + ',"cwd":' + JSON.stringify(folder) + "}\n";
  return base;
};
const filler = (n: number, width: number): string => '{"parentUuid":"u' + String(n - 1) + '","type":"assistant","uuid":"u' + String(n) + '","cwd":' + JSON.stringify(folder) + ',"message":{"content":[{"type":"text","text":"' + "x".repeat(width) + '"}]}}\n';

// The big session: head records, then 120 MB of assistant lines with bookkeeping records among
// them, one 3 MB line, an old title early and the latest title 100 KB before the end.
const bigId = "aaaaaaaa-0000-0000-0000-000000000001";
const big = join(dir, bigId + ".jsonl");
let kept = 0;
let head = rec({ type: "mode", mode: "normal", sessionId: bigId });
head += rec({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId: bigId });
head += '{"parentUuid":null,"type":"system","subtype":"informational","content":"note","cwd":' + JSON.stringify(folder) + ',"uuid":"s0"}\n';
head += user("m0", "<local-command-caveat>Caveat: ignore</local-command-caveat>", '"isMeta":true,');
head += user("c0", "<command-name>/effort</command-name>", "");
head += user("p0", "Build the parser for the new format", "");
kept += 5;
writeFileSync(big, head);
let n = 1;
// Natively a string `+=` copies the whole string, so lines gather in an array and are joined
// once per megabyte.
let chunk: string[] = [];
let chunkBytes = 0;
const add = (line: string): void => {
  chunk.push(line);
  chunkBytes += line.length;
};
for (let i = 0; i < 120000; i++) {
  add(filler(n++, 900));
  kept++;
  if (i % 100 === 0) add(rec({ type: "file-history-snapshot", messageId: "f" + String(i) }));
  if (i === 10) {
    add(rec({ type: "ai-title", aiTitle: "Old title", sessionId: bigId }));
    kept++;
  }
  if (i === 60000) {
    add(filler(n++, 3 * 1024 * 1024));
    kept++;
  }
  if (i === 119900) {
    add(rec({ type: "ai-title", aiTitle: "Parser work", sessionId: bigId }));
    add(rec({ type: "last-prompt", lastPrompt: "and the tests", sessionId: bigId }));
    kept++;
  }
  if (chunkBytes > 1000000) {
    appendFileSync(big, chunk.join(""));
    chunk = [];
    chunkBytes = 0;
  }
}
appendFileSync(big, chunk.join(""));
appendFileSync(big, '{"parentUuid":"u-last","type":"assistant","message":{"content":[{"type":"text","text":"still being wri');

// A sparse 1 GB session: reading it whole would fail (or take seconds); its head and tail are real.
const sparseId = "bbbbbbbb-0000-0000-0000-000000000002";
const sparse = join(dir, sparseId + ".jsonl");
writeFileSync(sparse, user("p0", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "Look at this screenshot" }], ""));
const fd = openSync(sparse, "r+");
const gb = 1024 * 1024 * 1024;
ftruncateSync(fd, gb);
writeSync(fd, "\n" + rec({ type: "custom-title", customTitle: "Renamed by me", sessionId: sparseId }) + rec({ type: "ai-title", aiTitle: "AI name", sessionId: sparseId }), gb);
closeSync(fd);

writeFileSync(join(dir, "cccccccc-0000-0000-0000-000000000003.jsonl"), user("p0", "Prompt only", ""));
writeFileSync(join(dir, "dddddddd-0000-0000-0000-000000000004.jsonl"), user("p0", "Elsewhere", "").replace(JSON.stringify(folder), JSON.stringify("/home/someone/Projects/my/app/v2")));
writeFileSync(join(dir, "eeeeeeee-0000-0000-0000-000000000005.jsonl"), "");
writeFileSync(join(dir, "notes.txt"), "not a session");

utimesSync(big, 1000, 3000);
utimesSync(sparse, 1000, 2000);
utimesSync(join(dir, "cccccccc-0000-0000-0000-000000000003.jsonl"), 1000, 1000);

const agents = join(dir, bigId, "subagents");
mkdirSync(agents, { recursive: true });
writeFileSync(join(agents, "agent-a1.jsonl"), filler(1, 10) + filler(2, 10));
writeFileSync(join(agents, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Look around", toolUseId: "toolu_1", spawnDepth: 1 }));
writeFileSync(join(agents, "agent-bad.meta.json"), "{");

// An older CLI kept subagents' transcripts beside the sessions, as agent-<id>.jsonl.
writeFileSync(join(dir, "agent-a1fc8f3.jsonl"), user("p0", "Subagent prompt", ""));

// The plugin's agent, reading this projects folder.
const home = mkdtempSync(join(tmpdir(), "code-sessions-folder-"));
const ws = await openWorkspace(home, 100);
const c = new Conversation(ws.folder);
const config: unknown = { claude: { projects: root } };
const w = createWidecode(ws, c, config);
const claude = w.js.agents.find((a) => a.agentId === "claude");
const listOf = (f: string): Listed[] => (claude !== undefined ? (JSON.parse(claude.sessions(f)) as Listed[]) : []);
eq("the folder's directory name", dir.slice(root.length + 1), "-home-someone-Projects-my-app-v2");
ok("agent-*.jsonl beside the sessions are subagents', not sessions", !listOf(folder).some((s: Listed) => s.id.startsWith("agent-")));

const t0 = Date.now();
const list = listOf(folder);
const listMs = Date.now() - t0;
eq("sessions newest first; another folder's, empty ones and non-sessions left out", list.map((s: Listed) => s.id.slice(0, 8)).join(","), "aaaaaaaa,bbbbbbbb,cccccccc");
eq("the latest AI title, found beyond the first tail window", list[0].title, "Parser work");
eq("the first real prompt from the head", list[0].firstPrompt, "Build the parser for the new format");
eq("a custom title wins", list[1].title, "Renamed by me");
eq("the text of a prompt with an image", list[1].firstPrompt, "Look at this screenshot");
eqn("the sparse file's size", list[1].size, gb + 1 + Buffer.byteLength(rec({ type: "custom-title", customTitle: "Renamed by me", sessionId: sparseId }) + rec({ type: "ai-title", aiTitle: "AI name", sessionId: sparseId })));
eq("no title: none, the first prompt stands", list[2].title + "|" + list[2].firstPrompt, "|Prompt only");
ok("listing a 1 GB and a 120 MB file reads heads and tails only (under 1 s)", listMs < budget(1000));
appendFileSync(join(dir, "cccccccc-0000-0000-0000-000000000003.jsonl"), rec({ type: "ai-title", aiTitle: "Now titled" }));
eq("a changed file is read again", listOf(folder).filter((s: Listed) => s.id.startsWith("cccc"))[0].title, "Now titled");

// History, newest window first, walked back to the start; the records the plugin never shows left out.
const SKIP = ['{"type":"file-history-snapshot"', '{"type":"file-history-delta"', '{"type":"queue-operation"', '{"type":"atis-latch"', '{"type":"last-prompt"', '{"type":"mode"'];
let before = -1;
let windows = 0;
let lines = 0;
let lastEnd = -1;
let aligned = true;
let parsed = true;
let joined = true;
let giant = false;
let bookkeeping = false;
let firstEnd = 0;
let size = 0;
let grew = false;
for (;;) {
  const win = readWindow(big, before, 1024 * 1024, SKIP);
  if (windows === 0) {
    firstEnd = win.end;
    size = win.size;
  }
  windows++;
  if (lastEnd >= 0 && win.end !== lastEnd) joined = false;
  lastEnd = win.start;
  if (win.end - win.start > 2 * 1024 * 1024) grew = true;
  for (const line of win.lines) {
    if (line.length > 3 * 1024 * 1024) giant = true;
    if (line.startsWith('{"type":"file-history')) bookkeeping = true;
  }
  if (win.lines.length === 0) aligned = false;
  else
    try {
      JSON.parse(win.lines[0]);
      JSON.parse(win.lines[win.lines.length - 1]);
    } catch {
      parsed = false;
    }
  lines += win.lines.length;
  if (win.start === 0) break;
  before = win.start;
  if (windows > 1000) break;
}
ok("about one window per MB", windows >= 110 && windows <= 130);
eqn("every kept line, once", lines, kept);
ok("windows meet end to start", joined);
ok("each window's first and last lines are whole records", parsed && aligned);
ok("the 3 MB line came whole, its window grown", giant && grew);
ok("bookkeeping records are left out", !bookkeeping);
ok("the line still being written is left out", firstEnd < size && size - firstEnd === Buffer.byteLength('{"parentUuid":"u-last","type":"assistant","message":{"content":[{"type":"text","text":"still being wri'));
eqn("a file that is not there has no lines", readWindow(join(dir, "ffffffff-0000.jsonl"), -1, 1024, []).lines.length, 0);

// A session resumed: its Agent call shows what its subagent did, from the subagent's own file.
const subId = "ffffffff-0000-0000-0000-000000000006";
writeFileSync(
  join(dir, subId + ".jsonl"),
  user("p1", "Look around the code", "") +
    rec({ type: "assistant", uuid: "a1", parentUuid: "p1", cwd: folder, message: { id: "m1", content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { subagent_type: "Explore", description: "Look around", prompt: "Look" } }] } }),
);
const subAgents = join(dir, subId, "subagents");
mkdirSync(subAgents, { recursive: true });
writeFileSync(join(subAgents, "agent-a1.jsonl"), filler(1, 10) + filler(2, 10));
writeFileSync(join(subAgents, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Look around", toolUseId: "toolu_1", spawnDepth: 1 }));
writeFileSync(join(subAgents, "agent-bad.meta.json"), "{");
// The plugin reads the sessions of the workspace's folder.
c.resume(subId, "");
ok("a session in another folder's directory is not this folder's: nothing shown, a notice naming the transcript missing", c.firstExchange().prompt.length === 0 && c.model.lastNoticeIs("No transcript for " + subId + " under " + projectDir(root, home) + ": the session may belong to another agent (/agent lists them)."));
// The same session under this folder: resumed, its subagent read into its call.
const here = projectDir(root, home);
mkdirSync(join(here, subId, "subagents"), { recursive: true });
writeFileSync(join(here, subId + ".jsonl"), user("p1", "Look around the code", "").split(JSON.stringify(folder)).join(JSON.stringify(home)) + rec({ type: "assistant", uuid: "a1", parentUuid: "p1", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { subagent_type: "Explore", description: "Look around", prompt: "Look" } }] } }));
writeFileSync(join(here, subId, "subagents", "agent-a1.jsonl"), filler(1, 10) + filler(2, 10));
writeFileSync(join(here, subId, "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Look around", toolUseId: "toolu_1", spawnDepth: 1 }));
writeFileSync(join(here, subId, "subagents", "agent-bad.meta.json"), "{");
c.resume(subId, "");
const call = c.model.tool("toolu_1");
ok("resumed: its Agent call", call !== null && call.kind === TOOL && call.children.length === 0);
const notices = c.model.turns.flatMap((t) => t.after.children.concat(t.body.children)).filter((i) => i.kind === NOTICE);
eq("a file written a moment ago that no Claude runs: no warning", notices.map((i) => i.text).join("|"), "");
ok("its subagent's steps read into the call, from the meta file naming it (a broken one skipped)", call !== null && c.loadSubagent(call) && call.children.length === 2);
ok("an item no subagent ran for: nothing read", !c.loadSubagent(c.model.turns[0].body));

const sessions = join(base, "sessions");
mkdirSync(sessions);
const startOf = (pid: number): string => {
  const fd = openSync("/proc/" + String(pid) + "/stat", "r");
  const stat = readAt(fd, 0, 1024).toString("utf8");
  closeSync(fd);
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
};
const record = (pid: number, procStart: string): void => writeFileSync(join(sessions, String(pid) + ".json"), JSON.stringify({ pid, sessionId: subId, cwd: home, procStart, status: "busy" }));
const warned = (): string => {
  c.resume(subId, "");
  return c.model.turns.flatMap((t) => t.after.children.concat(t.body.children)).filter((i) => i.kind === NOTICE).map((i) => i.text).join("|");
};
record(1, startOf(1));
eq("a live Claude that widecode did not start: named by its pid", warned(), "Another Claude (pid 1) is running this session.");
record(1, String(Number(startOf(1)) + 1));
eq("a record whose pid now belongs to a later process: no warning", warned(), "");
rmSync(join(sessions, "1.json"));
record(99999999, "1");
eq("a record whose process ended: no warning", warned(), "");
const own = spawn("sleep", ["30"]);
const ownPid = own.pid ?? 0;
record(ownPid, startOf(ownPid));
eq("widecode's own Claude, still stopping: no warning", warned(), "");
own.kill();

w.host.kernel.stop();
ws.close();
rmSync(base, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
