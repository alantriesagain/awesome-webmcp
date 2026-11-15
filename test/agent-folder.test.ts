// ffi: @light/plugins/native/ffi.json
// The agent chosen carries over a folder switch when the new folder's plugins bring it too: the old
// folder's agent goes with its plugins, and the new folder's agent of the same id takes the chat.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { done, eq } from "@light/test/assert.ts";

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
  const dirA = project(folderA, "Agent A");
  project(folderB, "Agent B");
  const ws = await openWorkspace(folderA, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  w.js.dirs = [dirA];
  w.host.session.agentId.value = "x";
  w.start(null, new NoStateFile(), []);
  await w.host.load();
  eq("the first folder's agent", c.agent.id() + " " + c.agent.name(), "x Agent A");

  await w.host.openFolder(folderB);
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
