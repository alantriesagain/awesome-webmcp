// ffi: @lightstart/plugins/native/ffi.json
// The plugin that brought the agent the conversation talks to is removed: the conversation goes
// back to Claude Code, the plugin's command goes with it, and a message is no longer queued to a
// plugin that is not there.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lightcode } from "../src/compose.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { openLightcode } from "./support/app.ts";

const plugin = `lightcode.plugin({
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
  const folder = mkdtempSync(join(tmpdir(), "lightcode-agent-removal-"));
  const dir = join(folder, ".lightcode", "plugins");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "tmp.js");
  writeFileSync(file, plugin);
  const w = await openLightcode({
    folder,
    load: true,
    before: (w: Lightcode) => {
      w.js.dirs = [dir];
      w.host.session.agentId.value = "tmp";
    },
  });
  const c = w.host.conversation;
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
