// ffi: @lightstart/plugins/native/ffi.json
// The agent chosen carries over a folder switch when the new folder's plugins bring it too: the old
// folder's agent goes with its plugins, and the new folder's agent of the same id takes the chat.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Widecode } from "../src/compose.ts";
import { done, eq } from "@lightstart/test/assert.ts";
import { currentWidecode, openWidecode } from "./support/app.ts";
import { openFolder } from "../src/host/actions.ts";

const plugin = (name: string): string => `widecode.plugin({
  id: "agent-x",
  activate(api) {
    api.agents.register({ id: "x", name: "${name}", start: () => "", send: () => "" });
  },
});`;

const project = (root: string, name: string): string => {
  const dir = join(root, ".widecode", "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.js"), plugin(name));
  return dir;
};

const main = async (): Promise<void> => {
  const folderA = mkdtempSync(join(tmpdir(), "widecode-agent-folder-a-"));
  const folderB = mkdtempSync(join(tmpdir(), "widecode-agent-folder-b-"));
  project(folderA, "Agent A");
  project(folderB, "Agent B");
  // The folder's own plugins, whichever folder the app opens: an /open starts it again there.
  let w = await openWidecode({
    folder: folderA,
    load: true,
    before: (w: Widecode) => {
      w.js.dirs = [w.host.harness.pluginsDir()];
      w.host.session.agentId.value = "x";
    },
  });
  const c = w.host.conversation;
  eq("the first folder's agent", c.agent.id() + " " + c.agent.name(), "x Agent A");

  await openFolder(folderB);
  w = currentWidecode();
  eq("the new folder's agent of the same id takes the chat", w.host.conversation.agent.id() + " " + w.host.conversation.agent.name(), "x Agent B");

  w.host.kernel.stop();
  w.js.stopWatching();
  w.host.workspace.close();
  rmSync(folderA, { recursive: true, force: true });
  rmSync(folderB, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
