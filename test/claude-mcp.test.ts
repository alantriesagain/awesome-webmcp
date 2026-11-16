// ffi: @lightstart/plugins/native/ffi.json
// widecode's tools served to Claude Code: the CLI is started with --mcp-config naming a file the
// user alone reads, which carries the server's address and this plugin's token; with that token the
// server lists the tools not excepted for Claude (a test plugin's, not the ask plugin's AskUser and
// PresentPlan); a tool added while the CLI runs (a plugin file saved) is picked up at the turn's end,
// when the CLI stops and the next message starts it again on the same session. Against the fake
// CLI replaying a turn that asks a question, so the turn stays open while the plugin is saved.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSource } from "@lightstart/plugins/sources.ts";
import type { Widecode } from "../src/compose.ts";
import { openWidecode } from "./support/app.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";

const fixtures = join(process.cwd(), "test", "fixtures");
const fake = join(process.cwd(), "test", "fake-claude.mjs");

const probe = `widecode.plugin({ id: "probe", activate(api) {
  api.tools.add({ name: "probe_tool", description: "a probe", input: { type: "object", properties: {} }, call: () => "probed" });
} });`;
const later = `widecode.plugin({ id: "later", activate(api) {
  api.tools.add({ name: "later_tool", description: "added later", input: { type: "object", properties: {} }, call: () => "later" });
} });`;

/** A JSON-RPC POST to the server with `token`: the body's text. */
const post = (url: string, token: string, body: string): Promise<string> =>
  new Promise((resolve) => {
    const port = Number(url.slice(url.lastIndexOf(":") + 1, url.lastIndexOf("/")));
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + token } }, (res: IncomingMessage) => {
      let text = "";
      res.on("data", (c: Buffer) => {
        text += c.toString("utf8");
      });
      res.on("end", () => resolve(String(res.statusCode) + " " + text));
    });
    req.on("error", (e: Error) => resolve("error " + e.message));
    req.end(body);
  });

const toolNames = (answer: string): string => {
  const at = answer.indexOf("{");
  if (at < 0) return answer;
  const v = JSON.parse(answer.slice(at)) as { result?: { tools?: { name: string }[] } };
  return (v.result?.tools ?? []).map((t) => t.name).join(",");
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-claude-mcp-"));
  const dir = join(folder, ".widecode", "plugins");
  mkdirSync(dir, { recursive: true });
  const args = join(folder, "args.txt");
  const logs: string[] = [];
  const w = await openWidecode({
    folder,
    before: (w: Widecode) => {
      w.host.conversation.executable = fake;
      w.host.conversation.extraArgs.push("--fixture", join(fixtures, "ask.ndjson"), "--record-args", args);
      w.js.dirs = [dir];
      w.js.extra = [new PluginSource("probe.js", probe)];
    },
  });
  const c = w.host.conversation;
  w.host.onLog = (text: string) => logs.push(text);
  await w.host.load();
  const mcp = w.js.mcp;
  ok("the Claude plugin asked for the server at its start", await until(() => mcp.url.length > 0, 3000));
  const token = mcp.tokenFor("claude");

  c.send("go", []);
  ok("the turn asks a question, so it stays open", await until(() => c.model.openRequests().length > 0, 10000));
  const argv = readFileSync(args, "utf8").split("\n");
  const at = argv.indexOf("--mcp-config");
  const file = at >= 0 ? argv[at + 1] : "";
  ok("the CLI was started with --mcp-config naming a file", at >= 0 && file.length > 0 && !argv.includes("--resume"));
  eq("the file is the user's alone", (statSync(file).mode & 0o777).toString(8), "600");
  const config = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: { widecode: { type: string; url: string; headers: { Authorization: string } } } };
  eq("and names the server and this plugin's token", [config.mcpServers.widecode.type, config.mcpServers.widecode.url === mcp.url, config.mcpServers.widecode.headers.Authorization === "Bearer " + token].join(" "), "http true true");
  eq("with that token the server lists the tools not excepted for Claude, the harness plugin's first", toolNames(await post(mcp.url, token, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')), "screen,state,log,reload,api,check,config,probe_tool");
  ok("the ask plugin's tools stay Claude's own", !toolNames(await post(mcp.url, token, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')).includes("AskUser"));
  ok("a call with it answers", (await post(mcp.url, token, '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"probe_tool","arguments":{}}}')).includes('"text":"probed"'));

  writeFileSync(join(dir, "b.js"), later);
  w.js.syncFolder(dir);
  eq("a plugin saved during the turn adds its tool to the server", toolNames(await post(mcp.url, token, '{"jsonrpc":"2.0","id":4,"method":"tools/list"}')), "screen,state,log,reload,api,check,config,probe_tool,later_tool");
  ok("the CLI goes on with the turn", c.started && !logs.some((l) => l.includes("claude exited")));
  const sid = c.sessionId;
  w.chat.pane.panel.key(new KeyEvent("char", "1", false, false, false), true);
  ok("the question answered, the turn ends and the CLI stops to pick the new tool up", await until(() => !c.started, 10000) && logs.some((l) => l.includes("claude stopped to pick up the harness")) && !logs.some((l) => l.includes("Claude exited during the turn")));
  c.send("again", []);
  ok("the next message starts it again on the same session, with the server", await until(() => c.started && readFileSync(args, "utf8").includes("--resume\n" + sid) && readFileSync(args, "utf8").includes("--mcp-config"), 10000));

  c.kill();
  mcp.close();
  w.host.workspace.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
