// ffi: @light/plugins/native/ffi.json
// A plugin's two parts talk: a `_widecode/plugin` message from the fake agent (test/fake-acp.mjs)
// reaches the listener a user plugin registered with api.agentPart.on, only that plugin's, and
// api.agentPart.send goes back to the agent as `_widecode/plugin` with the plugin's id.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { PluginSource } from "@light/plugins/sources.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { done, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-agent-part-talk-"));
  const log = join(folder, "fake.log");
  const fake = join(process.cwd(), "test/fake-acp.mjs");
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  w.host.session.agentId.value = "fake";
  const demo = [
    'widecode.plugin({ id: "demo", activate(api) {',
    '  api.agentPart.on("ping", (data) => { api.agentPart.send("pong", { echo: data.name }); });',
    "} });",
  ].join("\n");
  const other = [
    'widecode.plugin({ id: "other", activate(api) {',
    '  api.agentPart.on("ping", (data) => { api.agentPart.send("other", { saw: data.name }); });',
    "} });",
  ].join("\n");
  w.js.extra = [new PluginSource("demo.js", demo), new PluginSource("other.js", other)];
  const config: unknown = { acp: { agents: { fake: { name: "Fake", command: ["node", fake, "--log", log] } } } };
  w.start(config, new NoStateFile(), []);
  c.prepare();
  await w.host.load();
  const sent = (): string => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const idle = (): boolean => !c.model.running && c.model.pending.length === 0;
  const before = c.model.turns.length;
  w.host.roles.chat.submit("plugin");

  ok(
    "the plugin's listener gets the agent's message and sends back",
    await until(() => sent().includes('"method":"_widecode/plugin"') && sent().includes('"plugin":"demo"') && sent().includes('"type":"pong"') && sent().includes('"echo":"hello"') && idle() && c.model.turns.length > before),
  );
  ok("another plugin's listener did not get it", !sent().includes('"type":"other"'));

  w.host.kernel.stop();
  w.js.killProcesses();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
