// ffi: @light/plugins/native/ffi.json
// The plugin that brought the agent the conversation talks to is removed: the conversation goes
// back to Claude Code, the plugin's command goes with it, and a message is no longer queued to a
// plugin that is not there.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const plugin = `widecode.plugin({
  id: "temp-agent",
  activate(api) {
    api.agents.register({
      id: "tmp",
      name: "Tmp",
      start: () => "",
      send: () => "",
    });
    api.commands.add({ name: "/tmp", run: () => api.tell("tmp") });
  },
});`;

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-agent-removal-"));
  const dir = join(folder, ".widecode", "plugins");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "tmp.js");
  writeFileSync(file, plugin);
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  w.js.dirs = [dir];
  w.host.session.agentId.value = "tmp";
  w.start(null, new NoStateFile(), []);
  await w.host.load();
  eq("the plugin's agent is the one talked to", c.agent.id() + " " + c.agent.name(), "tmp Tmp");
  ok("its command runs", w.host.kernel.commands.run("/tmp"));

  rmSync(file);
  w.js.syncFolder(dir);
  eq("removed, the conversation is back on Claude Code", c.agent.id() + " " + w.host.session.agentId.peek(), "claude claude");
  ok("the plugin's command went with it", !w.host.kernel.commands.run("/tmp"));
  eq("and nothing is queued to the agent that left", String(c.running) + " " + String(c.model.pending.length), "false 0");

  w.host.kernel.stop();
  w.js.stopWatching();
  w.host.workspace.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
