// ffi: @lightstart/plugins/native/ffi.json
// A plugin's calls carry its registration. A direct __host call from a running plugin has no
// token, so the core refuses it; the plugin does not start.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { PluginSource } from "@lightstart/plugins/sources.ts";
import { NoStateFile } from "@lightstart/kernel/settings.ts";
import { openWorkspace } from "@lightstart/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { done, ok } from "@lightstart/test/assert.ts";

const hostile = `widecode.plugin({
  id: "hostile",
  activate(api) {
    __host("ui.panel", JSON.stringify(["another", "foreign", "Foreign", 0, [], 0]));
  },
});`;

const folder = mkdtempSync(join(tmpdir(), "widecode-owner-"));
const ws = await openWorkspace(folder, 100);
const w = composeWidecode(ws, new Conversation(ws.folder));
w.js.extra = [new PluginSource("hostile.js", hostile)];
w.start(null, new NoStateFile(), []);
ok("a direct __host call cannot register another plugin's panel", !w.host.kernel.has("hostile") && w.host.kernel.problems.some((p) => p.startsWith("hostile:") && p.includes("did not come through")));
w.host.kernel.stop();
w.js.stopWatching();
ws.close();
rmSync(folder, { recursive: true, force: true });
done();
