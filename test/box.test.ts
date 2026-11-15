// ffi: @light/plugins/native/ffi.json
// Host actions (the box plugin): commands a project configures for agents to ask the host to run.
// HostAction is offered only while one is configured, its call opens the question under the call
// with the command and the agent's reason, "Run it" runs it in the session's folder and answers its
// exit code and output, "Don't run" answers an error and runs nothing, an unknown action is
// refused, and /box lists the actions. A plugin switched off or a section with no actions offers no
// tool.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import * as net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { TOOL } from "../src/conversation/model.ts";
import { Answer, Reply } from "../src/conversation/requests.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { done, eq, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

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

const callBody = (id: number, arguments_: unknown, toolUseId: string): string => {
  const meta: unknown = toolUseId.length > 0 ? { "claudecode/toolUseId": toolUseId } : {};
  const params: unknown = { name: "HostAction", arguments: arguments_, _meta: meta };
  return JSON.stringify({ jsonrpc: "2.0", id: id, method: "tools/call", params: params });
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-box-"));
  const marker = join(folder, "marker.txt");
  const run = "printf 'hello\\n' > marker.txt; echo done; echo err >&2";
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  w.start({ box: { hostActions: { install: { run: run, description: "install the build", timeoutMs: 5000 } } } }, new NoStateFile(), []);
  await w.host.load();
  const url = await w.js.mcp.start();
  const token = w.js.mcp.tokenFor("claude");
  const post = (body: string): Promise<string> => send(url, token, body);

  const listed = await post('{"jsonrpc":"2.0","id":0,"method":"tools/list"}');
  ok("the tool is listed with its configured action", listed.includes('"name":"HostAction"') && listed.includes('"enum":["install"]') && listed.includes("install the build"));

  c.model.openTurn("main", 0, true);
  const call = c.model.block("", "tc", TOOL, "toolu-box", "HostAction", "");
  ok("the HostAction call is made", call !== null);
  if (call === null) return;
  const pending = post(callBody(1, { action: "install", reason: "the build is ready" }, "toolu-box"));
  ok("a call opens the question", await until(() => c.model.openRequests().length > 0, 5000));
  const asked = c.model.openRequests()[0];
  eq("under the call", String(asked !== undefined && asked.turn === call.turn && call.children.includes(asked)), "true");
  const question = asked !== undefined ? asked.questions[0] : null;
  eq("the question carries the header", question !== null ? question.header : "none", "Host action");
  ok("the command and the reason", question !== null && question.question.includes("Run on the host: install (" + run + ")?") && question.question.includes("the build is ready"));
  eq("the two choices", question !== null ? question.options.map((o) => o.label).join(",") : "none", "Run it,Don't run");
  const allow = new Reply("answered");
  const yes = new Answer(question !== null ? question.question : "", false);
  yes.labels.push("Run it");
  allow.answers.push(yes);
  c.respond(asked, allow);
  const answer = await pending;
  eq("the marker was written", existsSync(marker) ? readFileSync(marker, "utf8") : "none", "hello\n");
  ok("the answer has the exit code and the output", answer.includes("exit code 0") && answer.includes("done") && answer.includes("err"));
  c.model.closeTurn(null);

  c.model.openTurn("main", 0, true);
  const refusedCall = c.model.block("", "tcrefused", TOOL, "toolu-refused", "HostAction", "");
  ok("the refused call is made", refusedCall !== null);
  rmSync(marker, { force: true });
  const refusedPending = post(callBody(2, { action: "install", reason: "again" }, "toolu-refused"));
  ok("its question opens", await until(() => c.model.openRequests().length > 0, 5000));
  const refusedAsked = c.model.openRequests()[0];
  const deny = new Reply("answered");
  const no = new Answer(refusedAsked !== undefined ? refusedAsked.questions[0].question : "", false);
  no.labels.push("Don't run");
  deny.answers.push(no);
  c.respond(refusedAsked, deny);
  const refused = await refusedPending;
  ok("refused: an error naming the action", refused.includes("the user did not approve install"));
  ok("and nothing ran", !existsSync(marker));
  c.model.closeTurn(null);

  const unknown = await post(callBody(3, { action: "deploy", reason: "ship it" }, "toolu-unknown"));
  ok("an unknown action is refused with the valid ones", unknown.includes("no host action deploy") && unknown.includes("install"));

  w.host.roles.chat.submit("/box");
  eq("/box lists the actions", w.host.screen.message.peek(), "host actions: install");

  w.host.kernel.stop();
  w.js.killProcesses();
  ws.close();
  rmSync(folder, { recursive: true, force: true });

  const emptyFolder = mkdtempSync(join(tmpdir(), "widecode-box-empty-"));
  const emptyWs = await openWorkspace(emptyFolder, 100);
  const emptyC = new Conversation(emptyWs.folder);
  const empty = composeWidecode(emptyWs, emptyC);
  empty.start({ box: { hostActions: {} } }, new NoStateFile(), []);
  await empty.host.load();
  const emptyUrl = await empty.js.mcp.start();
  const emptyListed = await send(emptyUrl, empty.js.mcp.tokenFor("claude"), '{"jsonrpc":"2.0","id":0,"method":"tools/list"}');
  ok("no actions configured: no tool", !emptyListed.includes('"name":"HostAction"'));
  empty.host.roles.chat.submit("/box");
  eq("/box says there are none", empty.host.screen.message.peek(), "no host actions configured");
  empty.host.kernel.stop();
  empty.js.killProcesses();
  emptyWs.close();
  rmSync(emptyFolder, { recursive: true, force: true });

  const offFolder = mkdtempSync(join(tmpdir(), "widecode-box-off-"));
  const offWs = await openWorkspace(offFolder, 100);
  const offC = new Conversation(offWs.folder);
  const off = composeWidecode(offWs, offC);
  off.start({ box: false }, new NoStateFile(), []);
  await off.host.load();
  const offUrl = await off.js.mcp.start();
  const offListed = await send(offUrl, off.js.mcp.tokenFor("claude"), '{"jsonrpc":"2.0","id":0,"method":"tools/list"}');
  ok("the plugin switched off offers no tool", !offListed.includes('"name":"HostAction"'));
  off.host.kernel.stop();
  off.js.killProcesses();
  offWs.close();
  rmSync(offFolder, { recursive: true, force: true });

  // The jail's bwrap argv, the proxy's unix socket and down --if-idle. The jail is checked with
  // --dry-run, so the test needs no bubblewrap; the live jail is checked on the host.
  const boxScript = join(process.cwd(), "box/box.mjs");
  const boxEnv = (state: string) => ({ ...process.env, WIDECODE_BOX_DIR: state });
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  const runBox = (folder: string | null, args: string[], env: NodeJS.ProcessEnv) => {
    const command = `exec node ${args.map(quote).join(" ")}`;
    return spawnSync("sh", ["-c", folder === null ? command : `cd ${quote(folder)} && ${command}`], { encoding: "utf8", env });
  };
  const jailState = mkdtempSync(join(tmpdir(), "widecode-box-jail-"));
  const jailProject = mkdtempSync(join(tmpdir(), "widecode-box-project-"));
  mkdirSync(join(jailProject, ".widecode"));
  mkdirSync(join(jailProject, ".git"));
  mkdirSync(join(jailProject, ".worktrees", "task-1"), { recursive: true });
  writeFileSync(join(jailProject, ".worktrees", "task-1", ".git"), "gitdir: " + join(jailProject, ".git", "worktrees", "task-1") + "\n");
  mkdirSync(join(jailProject, ".worktrees", "stray"));
  const dry = runBox(
    jailProject,
    [boxScript, "jail", "--proxy-port", "8899", "--project", jailProject, "--dry-run", "--", "node", "-e", "0"],
    boxEnv(jailState),
  );
  eq("jail --dry-run exits 0", String(dry.status), "0");
  const argv = JSON.parse(dry.stdout.trim()) as string[];
  const triple = (flag: string, source: string, target: string): boolean =>
    argv.some((value, index) => value === flag && argv[index + 1] === source && argv[index + 2] === target);
  const setenv = (name: string): string => {
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === "--setenv" && argv[index + 1] === name) return argv[index + 2] ?? "";
    }
    return "";
  };
  ok("the jail uses unshare-all and dies with its parent", argv.includes("--unshare-all") && argv.includes("--die-with-parent"));
  ok("the project is bound read-write", triple("--bind", jailProject, jailProject));
  ok("its .widecode is read-only when present", triple("--ro-bind", join(jailProject, ".widecode"), join(jailProject, ".widecode")));
  ok("its .git is read-only whole", triple("--ro-bind", join(jailProject, ".git"), join(jailProject, ".git")));
  const tree = join(jailProject, ".worktrees", "task-1");
  ok("its .worktrees and each worktree are mount points", triple("--bind", join(jailProject, ".worktrees"), join(jailProject, ".worktrees")) && triple("--bind", tree, tree));
  ok("a worktree's .git file is read-only", triple("--ro-bind", join(tree, ".git"), join(tree, ".git")));
  ok("a folder in .worktrees with no .git is left as it is", !argv.includes(join(jailProject, ".worktrees", "stray")));
  const jailHome = join(jailState, "jail-home");
  ok("home is the jail home", triple("--bind", jailHome, homedir()));
  ok("no /run is bound", !argv.some((value) => value === "/run" || value.startsWith("/run/")));
  ok("the host home itself is not bound", !triple("--bind", homedir(), homedir()));
  ok(
    "no host .ssh or .config folder is bound",
    !argv.some((value) =>
      value === join(homedir(), ".ssh") || value.startsWith(join(homedir(), ".ssh") + "/") ||
      value === join(homedir(), ".config") || value.startsWith(join(homedir(), ".config") + "/")),
  );
  const proxyUrl = "http://127.0.0.1:8899";
  ok(
    "the proxy environment is set",
    setenv("HTTPS_PROXY") === proxyUrl && setenv("HTTP_PROXY") === proxyUrl &&
      setenv("https_proxy") === proxyUrl && setenv("http_proxy") === proxyUrl &&
      setenv("NO_PROXY") === "localhost,127.0.0.1",
  );
  const outside = mkdtempSync(join(tmpdir(), "widecode-box-outside-"));
  const cwdRefused = runBox(
    outside,
    [boxScript, "jail", "--proxy-port", "8899", "--project", jailProject, "--dry-run", "--", "true"],
    boxEnv(jailState),
  );
  eq("a cwd outside every project exits 1", String(cwdRefused.status), "1");
  ok("and says what to fix", ((cwdRefused.stdout || "") + (cwdRefused.stderr || "")).includes("is not inside a --project"));
  rmSync(outside, { recursive: true, force: true });
  rmSync(jailProject, { recursive: true, force: true });
  rmSync(jailState, { recursive: true, force: true });

  const proxyState = mkdtempSync(join(tmpdir(), "widecode-box-proxy-"));
  const freePort = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
  const proxyChild = spawn(
    "node",
    [boxScript, "proxy", "--port", String(freePort), "--allow", "api.anthropic.com"],
    { env: boxEnv(proxyState), stdio: "ignore" },
  );
  const socketPath = join(proxyState, "proxy.sock");
  const deadline = Date.now() + 5000;
  while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  ok("the proxy creates its unix socket", existsSync(socketPath));
  const overSocket = await new Promise<string>((resolve) => {
    const client = net.connect(socketPath, () => client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));
    let text = "";
    client.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes("\r\n")) {
        client.destroy();
        resolve(text);
      }
    });
    client.on("error", (error: Error) => resolve("error " + error.message));
    setTimeout(() => {
      client.destroy();
      resolve(text);
    }, 3000);
  });
  ok("its socket answers a disallowed CONNECT with 403", overSocket.includes("403"));
  proxyChild.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proxyChild.kill("SIGKILL");
      resolve();
    }, 3000);
    proxyChild.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  ok("the socket is removed with the proxy", !existsSync(socketPath));
  rmSync(proxyState, { recursive: true, force: true });

  const idleState = mkdtempSync(join(tmpdir(), "widecode-box-idle-"));
  mkdirSync(join(idleState, "sessions"));
  const stale = join(idleState, "sessions", "999999");
  writeFileSync(stale, "");
  const idle = spawnSync("node", [boxScript, "down", "--if-idle"], { encoding: "utf8", env: boxEnv(idleState) });
  eq("down --if-idle ignores a stale session", String(idle.status), "0");
  ok("and removes the stale file", !existsSync(stale));
  rmSync(idleState, { recursive: true, force: true });

  const liveState = mkdtempSync(join(tmpdir(), "widecode-box-live-"));
  mkdirSync(join(liveState, "sessions"));
  const live = join(liveState, "sessions", String(process.pid));
  writeFileSync(live, "");
  const busy = spawnSync("node", [boxScript, "down", "--if-idle"], { encoding: "utf8", env: boxEnv(liveState) });
  eq("down --if-idle leaves the box alone with a live session", String(busy.status), "0");
  ok("and says it is in use", ((busy.stdout || "") + (busy.stderr || "")).includes("the box is in use by 1 session(s)"));
  ok("and keeps the live session file", existsSync(live));
  rmSync(liveState, { recursive: true, force: true });

  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
