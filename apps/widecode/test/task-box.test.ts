// ffi: @light/plugins/native/ffi.json
// A boxed Task target: the run goes through `box.mjs ssh --forward-proxy`, the first run starts the
// box's proxy and the box with the session folder and the configured projects, a box with another
// project list fails the run with the box's message, an unboxed target runs its command on the
// host, worktrees live in `.worktrees/` (listed in `.git/info/exclude`), and the status segment
// says boxed or unboxed. The box credential file's shape checks run against fake files under /tmp.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { TOOL } from "@widecode/conversation/model.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { SegmentContext } from "@widecode/screen/contributions.ts";
import { openWorkspace, Workspace } from "@light/workspace/workspace.ts";
import { composeWidecode, Widecode } from "../src/compose.ts";
import { palette } from "@light/ui/palette.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const fake = join(process.cwd(), "test/fake-acp.mjs");
const fakeBox = join(process.cwd(), "test/fake-box.mjs");
const boxScript = join(process.cwd(), "box/box.mjs");

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

const reads = (state: string): { running: boolean; projects: string[]; proxy: boolean } => {
  const parsed = JSON.parse(readFileSync(state, "utf8")) as { running?: unknown; projects?: unknown; proxy?: unknown };
  return { running: parsed.running === true, projects: Array.isArray(parsed.projects) ? parsed.projects.map(String) : [], proxy: parsed.proxy === true };
};

const open = async (folder: string, config: unknown) => {
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  w.start(config, new NoStateFile(), []);
  await w.host.load();
  return { ws, c, w };
};

const close = (ws: Workspace, w: Widecode): void => {
  w.host.kernel.stop();
  w.js.killProcesses();
  ws.close();
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
        box: { script: fakeBox, proxyPort: 8899, memory: 2048, projects: [other] },
        targets: {
          deepseek: { agent: "fake", model: "fake/large", description: "a boxed test subagent", box: true },
          host: { agent: "fake", description: "a host subagent" },
        },
      },
    },
  };
  const { ws, c, w } = await open(folder, config);
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

  close(ws, w);
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
  eq("every target boxed says boxed", boxed.map((r) => r.text).join(""), "boxed");
  close(allBoxed.ws, allBoxed.w);
  rmSync(allBoxedFolder, { recursive: true, force: true });

  const noTargetsFolder = mkdtempSync(join(tmpdir(), "widecode-task-no-targets-"));
  const none = await open(noTargetsFolder, { acp: { tasks: { targets: {} } } });
  const noneSeg = none.w.host.screen.segments.find("box");
  const empty = noneSeg !== null ? noneSeg.draw(new SegmentContext()) : [];
  eq("no targets draw nothing", String(empty.length), "0");
  close(none.ws, none.w);
  rmSync(noTargetsFolder, { recursive: true, force: true });

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
