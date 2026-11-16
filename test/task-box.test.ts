// ffi: @lightstart/plugins/native/ffi.json
// A boxed Task target: a bwrap run goes through `box.mjs jail` with the proxy port and its projects
// and starts no VM, a VM run goes through `box.mjs ssh --forward-proxy`, starts the proxy and the box
// with the session folder and the configured projects, and stops once idle, a box with another
// project list fails the run with the box's message, an unboxed target runs its command on the host,
// worktrees live in `.worktrees/` (listed in `.git/info/exclude`), and the status segment names the
// backend or says unboxed. The box credential file's shape checks run against fake files under /tmp.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL } from "../src/conversation/model.ts";
import { SegmentContext } from "../src/screen/contributions.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { palette } from "@lightstart/tui/palette.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const fake = join(process.cwd(), "test/fake-acp.mjs");
const fakeBox = join(process.cwd(), "test/fake-box.mjs");
const boxScript = join(process.cwd(), "box/box.mjs");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const send = (url: string, token: string, body: string): Promise<string> =>
  new Promise((resolve) => {
    const port = Number(url.slice(url.lastIndexOf(":") + 1, url.lastIndexOf("/")));
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + token };
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: headers }, (res: IncomingMessage) => {
      const parts: string[] = [];
      res.on("data", (c: Buffer) => parts.push(c.toString("utf8")));
      res.on("end", () => resolve(String(res.statusCode) + " " + parts.join("")));
    });
    req.on("error", (e: Error) => resolve("error " + e.message));
    req.end(body);
  });

interface Logged {
  cmd: string;
  args: string[];
}

const calls = (file: string): Logged[] => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Logged);
};

const lastSessionCwd = (file: string): string => {
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = JSON.parse(lines[i]) as { method?: unknown; params?: { cwd?: unknown } };
    if (m.method === "session/new" && typeof m.params?.cwd === "string") return m.params.cwd;
  }
  return "";
};

const reads = (state: string): { running: boolean; projects: string[]; proxy: boolean } => {
  const parsed = JSON.parse(readFileSync(state, "utf8")) as { running?: unknown; projects?: unknown; proxy?: unknown };
  return { running: parsed.running === true, projects: Array.isArray(parsed.projects) ? parsed.projects.map(String) : [], proxy: parsed.proxy === true };
};

const open = async (folder: string, config: unknown) => {
  const w = await openWidecode({ folder, plugins: config, load: true });
  return { c: w.host.conversation, w };
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-task-box-"));
  const other = mkdtempSync(join(tmpdir(), "widecode-task-box-other-"));
  const boxDir = mkdtempSync(join(tmpdir(), "widecode-task-box-state-"));
  const boxLog = join(boxDir, "calls.jsonl");
  const acpLog = join(boxDir, "acp.jsonl");
  process.env.FAKE_BOX_DIR = boxDir;
  process.env.FAKE_BOX_LOG = boxLog;
  execFileSync("git", ["init", "-q"], { cwd: folder });
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: folder });

  const config = {
    acp: {
      agents: { fake: { name: "Fake", command: ["node", fake, "--log", acpLog] } },
      tasks: {
        box: { script: fakeBox, kind: "vm", proxyPort: 8899, memory: 2048, projects: [other] },
        targets: {
          deepseek: { agent: "fake", model: "fake/large", description: "a boxed test subagent", box: true },
          host: { agent: "fake", description: "a host subagent" },
        },
      },
    },
  };
  const { c, w } = await open(folder, config);
  const url = await w.js.mcp.start();
  const token = w.js.mcp.tokenFor("claude");
  const post = (body: string): Promise<string> => send(url, token, body);
  const task = (id: string, target: string, prompt: string, extra?: string): Promise<string> =>
    post('{"jsonrpc":"2.0","id":' + id + ',"method":"tools/call","params":{"name":"Task","arguments":{"description":"run","prompt":"' + prompt + '","subagent_type":"' + target + '"' + (extra ?? "") + '},"_meta":{"claudecode/toolUseId":"toolu-' + id + '"}}}');

  const seg = w.host.screen.segments.find("box");
  ok("the box segment is registered", seg !== null);
  const drawn = seg !== null ? seg.draw(new SegmentContext()) : [];
  eq("a boxed and a host target say unboxed", drawn.map((r) => r.text).join("") + " " + String(drawn[0]?.fg), "unboxed " + palette.warn);

  c.model.openTurn("main", 0, true);
  c.model.block("", "b1", TOOL, "toolu-b1", "Task", "");
  const first = await task("1", "deepseek", "hello");
  ok("a boxed run answers as before", first.includes("Hello, world."));
  const afterFirst = calls(boxLog);
  const ssh = afterFirst.filter((x) => x.cmd === "ssh");
  const proxy = afterFirst.filter((x) => x.cmd === "proxy");
  const up = afterFirst.filter((x) => x.cmd === "up");
  ok("it goes through ssh --forward-proxy", ssh.length === 1 && ssh[0].args.slice(0, 4).join(" ") === "--forward-proxy 8899 -- node" && ssh[0].args.includes(fake));
  ok("the first run starts the proxy", proxy.length === 1 && proxy[0].args.includes("--port") && proxy[0].args.includes("8899"));
  ok("and the box with the session folder and projects", up.length === 1 && up[0].args.includes(folder) && up[0].args.includes(other) && up[0].args.includes("2048"));
  eq("the box state says it runs with them", reads(join(boxDir, "fake-box.json")).projects.join(","), folder + "," + other);
  c.model.closeTurn(null);

  c.model.openTurn("main", 0, true);
  c.model.block("", "b2", TOOL, "toolu-b2", "Task", "");
  const second = await task("2", "deepseek", "hello");
  ok("the second boxed run answers too", second.includes("Hello, world."));
  const afterSecond = calls(boxLog);
  eq("the second run starts no proxy again", String(afterSecond.filter((x) => x.cmd === "proxy").length), "1");
  eq("and no box again", String(afterSecond.filter((x) => x.cmd === "up").length), "1");
  c.model.closeTurn(null);

  const outside = mkdtempSync(join(tmpdir(), "widecode-task-box-outside-"));
  c.model.openTurn("main", 0, true);
  c.model.block("", "b4", TOOL, "toolu-b4", "Task", "");
  const refusedWhere = await task("6", "deepseek", "hello", ',"cwd":"' + outside + '"');
  ok("a boxed run outside the box's folders is refused", refusedWhere.includes("a boxed subagent runs in a folder its box shares"));
  c.model.closeTurn(null);

  c.model.openTurn("main", 0, true);
  c.model.block("", "b5", TOOL, "toolu-b5", "Task", "");
  const inProject = await task("7", "deepseek", "hello", ',"cwd":"' + other + '"');
  ok("a boxed run in a folder the box shares is accepted", inProject.includes("Hello, world.") && lastSessionCwd(acpLog) === other);
  c.model.closeTurn(null);
  rmSync(outside, { recursive: true, force: true });

  c.model.openTurn("main", 0, true);
  const hostBlock = c.model.block("", "h1", TOOL, "toolu-h1", "Task", "");
  ok("the host call is made", hostBlock !== null);
  const beforeHost = calls(boxLog).length;
  const hostReply = await task("3", "host", "hello");
  ok("an unboxed target answers", hostReply.includes("Hello, world."));
  eq("and spawns nothing through the box", String(calls(boxLog).length), String(beforeHost));
  c.model.closeTurn(null);

  c.model.openTurn("main", 0, true);
  c.model.block("", "w1", TOOL, "toolu-w1", "Task", "");
  const work = await task("4", "deepseek", "change", ',"isolation":"worktree"');
  const workPath = (/\[worktree: (.+?) \(branch /.exec(work) ?? [])[1] ?? "";
  ok("a worktree run answers", work.includes("Changed."));
  ok("its worktree is under .worktrees", workPath.startsWith(folder + "/.worktrees/") && workPath.length > (folder + "/.worktrees/").length);
  ok("and keeps its change there", workPath.length > 0 && existsSync(join(workPath, "changed.txt")));
  ok("and .worktrees/ is in the repository's exclude file", readFileSync(join(folder, ".git", "info", "exclude"), "utf8").split("\n").includes(".worktrees/"));
  c.model.closeTurn(null);

  writeFileSync(join(boxDir, "fake-box.json"), JSON.stringify({ running: true, projects: ["/somewhere/else"], proxy: true }) + "\n");
  c.model.openTurn("main", 0, true);
  c.model.block("", "b3", TOOL, "toolu-b3", "Task", "");
  const mismatch = await task("5", "deepseek", "hello");
  ok("another project list fails with the box's message", mismatch.includes("the project list changed, so run down, then up again"));
  c.model.closeTurn(null);

  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
  rmSync(boxDir, { recursive: true, force: true });
  delete process.env.FAKE_BOX_DIR;
  delete process.env.FAKE_BOX_LOG;

  const allBoxedFolder = mkdtempSync(join(tmpdir(), "widecode-task-boxed-"));
  const allBoxed = await open(allBoxedFolder, {
    acp: {
      agents: { fake: { name: "Fake", command: ["node", fake] } },
      tasks: { box: { script: fakeBox }, targets: { deepseek: { agent: "fake", box: true } } },
    },
  });
  const boxedSeg = allBoxed.w.host.screen.segments.find("box");
  const boxed = boxedSeg !== null ? boxedSeg.draw(new SegmentContext()) : [];
  eq("every target boxed on the default kind says boxed: bwrap", boxed.map((r) => r.text).join(""), "boxed: bwrap");
  closeWidecode(allBoxed.w);
  rmSync(allBoxedFolder, { recursive: true, force: true });

  const noTargetsFolder = mkdtempSync(join(tmpdir(), "widecode-task-no-targets-"));
  const none = await open(noTargetsFolder, { acp: { tasks: { targets: {} } } });
  const noneSeg = none.w.host.screen.segments.find("box");
  const empty = noneSeg !== null ? noneSeg.draw(new SegmentContext()) : [];
  eq("no targets draw nothing", String(empty.length), "0");
  closeWidecode(none.w);
  rmSync(noTargetsFolder, { recursive: true, force: true });

  const bwrapFolder = mkdtempSync(join(tmpdir(), "widecode-task-bwrap-"));
  const bwrapOther = mkdtempSync(join(tmpdir(), "widecode-task-bwrap-other-"));
  const bwrapDir = mkdtempSync(join(tmpdir(), "widecode-task-bwrap-state-"));
  const bwrapLog = join(bwrapDir, "calls.jsonl");
  process.env.FAKE_BOX_DIR = bwrapDir;
  process.env.FAKE_BOX_LOG = bwrapLog;
  execFileSync("git", ["init", "-q"], { cwd: bwrapFolder });
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: bwrapFolder });
  const bwrapApp = await open(bwrapFolder, {
    acp: {
      agents: { fake: { name: "Fake", command: ["node", fake] } },
      tasks: {
        box: { script: fakeBox, proxyPort: 8899, projects: [bwrapOther] },
        targets: { deepseek: { agent: "fake", box: true } },
      },
    },
  });
  const bwrapSeg = bwrapApp.w.host.screen.segments.find("box");
  const bwrapDrawn = bwrapSeg !== null ? bwrapSeg.draw(new SegmentContext()) : [];
  eq("a bwrap box says boxed: bwrap", bwrapDrawn.map((r) => r.text).join(""), "boxed: bwrap");
  eq("in the ok colour", String(bwrapDrawn[0]?.fg), String(palette.ok));
  const bwrapUrl = await bwrapApp.w.js.mcp.start();
  const bwrapToken = bwrapApp.w.js.mcp.tokenFor("claude");
  const bwrapPost = (body: string): Promise<string> => send(bwrapUrl, bwrapToken, body);
  const bwrapTask = (id: string, target: string, prompt: string): Promise<string> =>
    bwrapPost('{"jsonrpc":"2.0","id":' + id + ',"method":"tools/call","params":{"name":"Task","arguments":{"description":"run","prompt":"' + prompt + '","subagent_type":"' + target + '"},"_meta":{"claudecode/toolUseId":"toolu-' + id + '"}}}');
  bwrapApp.c.model.openTurn("main", 0, true);
  bwrapApp.c.model.block("", "bw1", TOOL, "toolu-bw1", "Task", "");
  const bwrapReply = await bwrapTask("1", "deepseek", "hello");
  ok("a default bwrap run answers", bwrapReply.includes("Hello, world."));
  const bwrapCalls = calls(bwrapLog);
  const bwrapJail = bwrapCalls.filter((x) => x.cmd === "jail");
  eq(
    "its jail call gives the proxy port and the session folder then each configured project",
    bwrapJail.length === 1 ? bwrapJail[0].args.slice(0, 8).join(" ") : "",
    "--proxy-port 8899 --project " + bwrapFolder + " --project " + bwrapOther + " -- node",
  );
  ok("and runs the entry's command", bwrapJail.length === 1 && bwrapJail[0].args.includes(fake));
  eq("bwrap starts the proxy", String(bwrapCalls.filter((x) => x.cmd === "proxy").length), "1");
  eq("bwrap never starts a VM", String(bwrapCalls.filter((x) => x.cmd === "up").length), "0");
  closeWidecode(bwrapApp.w);
  rmSync(bwrapFolder, { recursive: true, force: true });
  rmSync(bwrapOther, { recursive: true, force: true });
  rmSync(bwrapDir, { recursive: true, force: true });
  delete process.env.FAKE_BOX_DIR;
  delete process.env.FAKE_BOX_LOG;

  const mixedFolder = mkdtempSync(join(tmpdir(), "widecode-task-mixed-"));
  const mixedDir = mkdtempSync(join(tmpdir(), "widecode-task-mixed-state-"));
  const mixedLog = join(mixedDir, "calls.jsonl");
  process.env.FAKE_BOX_DIR = mixedDir;
  process.env.FAKE_BOX_LOG = mixedLog;
  const mixedApp = await open(mixedFolder, {
    acp: {
      agents: { fake: { name: "Fake", command: ["node", fake] } },
      tasks: {
        box: { script: fakeBox, kind: "bwrap" },
        targets: { host: { agent: "fake", box: true }, vm: { agent: "fake", box: "vm" } },
      },
    },
  });
  const mixedSeg = mixedApp.w.host.screen.segments.find("box");
  const mixedDrawn = mixedSeg !== null ? mixedSeg.draw(new SegmentContext()) : [];
  eq("a bwrap target and a vm target say boxed: mixed", mixedDrawn.map((r) => r.text).join(""), "boxed: mixed");
  const mixedUrl = await mixedApp.w.js.mcp.start();
  const mixedToken = mixedApp.w.js.mcp.tokenFor("claude");
  const mixedPost = (body: string): Promise<string> => send(mixedUrl, mixedToken, body);
  const mixedTask = (id: string, target: string, prompt: string): Promise<string> =>
    mixedPost('{"jsonrpc":"2.0","id":' + id + ',"method":"tools/call","params":{"name":"Task","arguments":{"description":"run","prompt":"' + prompt + '","subagent_type":"' + target + '"},"_meta":{"claudecode/toolUseId":"toolu-' + id + '"}}}');
  mixedApp.c.model.openTurn("main", 0, true);
  mixedApp.c.model.block("", "mx1", TOOL, "toolu-mx1", "Task", "");
  const mixedReply = await mixedTask("1", "vm", "hello");
  ok("a per-target vm run answers", mixedReply.includes("Hello, world."));
  const mixedCalls = calls(mixedLog);
  eq("a per-target vm overrides the bwrap default with an ssh call", String(mixedCalls.filter((x) => x.cmd === "ssh").length), "1");
  eq("and starts the box", String(mixedCalls.filter((x) => x.cmd === "up").length), "1");
  eq("and does not use the jail", String(mixedCalls.filter((x) => x.cmd === "jail").length), "0");
  closeWidecode(mixedApp.w);
  rmSync(mixedFolder, { recursive: true, force: true });
  rmSync(mixedDir, { recursive: true, force: true });
  delete process.env.FAKE_BOX_DIR;
  delete process.env.FAKE_BOX_LOG;

  const idleFolder = mkdtempSync(join(tmpdir(), "widecode-task-idle-"));
  const idleDir = mkdtempSync(join(tmpdir(), "widecode-task-idle-state-"));
  const idleLog = join(idleDir, "calls.jsonl");
  process.env.FAKE_BOX_DIR = idleDir;
  process.env.FAKE_BOX_LOG = idleLog;
  const idleApp = await open(idleFolder, {
    acp: {
      agents: { fake: { name: "Fake", command: ["node", fake] } },
      tasks: {
        box: { script: fakeBox, kind: "vm", idleMinutes: 0.001 },
        targets: { deepseek: { agent: "fake", box: true } },
      },
    },
  });
  const idleSeg = idleApp.w.host.screen.segments.find("box");
  const idleDrawn = idleSeg !== null ? idleSeg.draw(new SegmentContext()) : [];
  eq("a vm box says boxed: vm", idleDrawn.map((r) => r.text).join(""), "boxed: vm");
  const idleUrl = await idleApp.w.js.mcp.start();
  const idleToken = idleApp.w.js.mcp.tokenFor("claude");
  const idlePost = (body: string): Promise<string> => send(idleUrl, idleToken, body);
  const idleTask = (id: string, target: string, prompt: string): Promise<string> =>
    idlePost('{"jsonrpc":"2.0","id":' + id + ',"method":"tools/call","params":{"name":"Task","arguments":{"description":"run","prompt":"' + prompt + '","subagent_type":"' + target + '"},"_meta":{"claudecode/toolUseId":"toolu-' + id + '"}}}');
  idleApp.c.model.openTurn("main", 0, true);
  idleApp.c.model.block("", "id1", TOOL, "toolu-id1", "Task", "");
  const idleRun = idleTask("1", "deepseek", "work");
  await sleep(300);
  eq("the box is not stopped while a run is in flight", String(calls(idleLog).filter((x) => x.cmd === "down").length), "0");
  const idleReply = await idleRun;
  ok("the work run answers", idleReply.includes("Worked."));
  await sleep(300);
  const downs = calls(idleLog).filter((x) => x.cmd === "down");
  eq("the idle box is stopped once after the last run", String(downs.length), "1");
  ok("through down --if-idle", downs.length === 1 && downs[0].args.includes("--if-idle"));
  eq("the VM had started", String(calls(idleLog).filter((x) => x.cmd === "up").length), "1");
  closeWidecode(idleApp.w);
  rmSync(idleFolder, { recursive: true, force: true });
  rmSync(idleDir, { recursive: true, force: true });
  delete process.env.FAKE_BOX_DIR;
  delete process.env.FAKE_BOX_LOG;

  // The credential file's shape checks, against fake files under /tmp: a wrong value is refused
  // with the key and what is wrong, never the value.
  const credsDir = mkdtempSync(join(tmpdir(), "widecode-box-creds-"));
  const credsFile = join(credsDir, "credentials.env");
  const boxState = join(credsDir, "state");
  mkdirSync(boxState);
  const creds = (body: string): { ok: boolean; text: string } => {
    writeFileSync(credsFile, body);
    chmodSync(credsFile, 0o600);
    const r = spawnSync("node", [boxScript, "creds"], {
      encoding: "utf8",
      env: { ...process.env, WIDECODE_BOX_CREDENTIALS: credsFile, WIDECODE_BOX_DIR: boxState },
    });
    return { ok: r.status === 0, text: (r.stdout || "") + (r.stderr || "") };
  };
  const good = "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc_DEF-123\nOPENCODE_API_KEY=abc_123-XYZ\n";
  const accepted = creds(good);
  ok("a well-shaped credential file is accepted", accepted.ok && accepted.text.includes("CLAUDE_CODE_OAUTH_TOKEN: set") && accepted.text.includes("OPENCODE_API_KEY: set"));
  ok("and values are never printed", !accepted.text.includes("sk-ant-oat01-abc_DEF-123") && !accepted.text.includes("abc_123-XYZ"));
  const badPrefix = creds("CLAUDE_CODE_OAUTH_TOKEN=wrong-value\n");
  ok("a Claude token with the wrong prefix is refused", !badPrefix.ok && badPrefix.text.includes("CLAUDE_CODE_OAUTH_TOKEN") && badPrefix.text.includes("must start with sk-ant-oat01-") && !badPrefix.text.includes("wrong-value"));
  const badChars = creds("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-bad!\n");
  ok("a Claude token with other characters is refused", !badChars.ok && badChars.text.includes("CLAUDE_CODE_OAUTH_TOKEN") && badChars.text.includes("may contain only") && !badChars.text.includes("bad!"));
  const badSpace = creds("OPENCODE_API_KEY=abc def\n");
  ok("an opencode key with whitespace is refused", !badSpace.ok && badSpace.text.includes("OPENCODE_API_KEY") && badSpace.text.includes("whitespace") && !badSpace.text.includes("abc def"));
  const badHash = creds("OPENCODE_API_KEY=abc#def\n");
  ok("an opencode key with # is refused", !badHash.ok && badHash.text.includes("OPENCODE_API_KEY") && badHash.text.includes('"#"') && !badHash.text.includes("abc#def"));
  rmSync(credsDir, { recursive: true, force: true });

  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exitCode = 1;
});
