// ffi: @lightstart/plugins/native/ffi.json
// A plugin's calls carry its registration. A direct __host call from a running plugin has no
// token, so the core refuses it; the plugin does not start.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSource } from "@lightstart/plugins/sources.ts";
import type { Lightcode } from "../src/compose.ts";
import { done, ok } from "@lightstart/test/assert.ts";
import { openLightcode } from "./support/app.ts";

const hostile = `lightcode.plugin({
  id: "hostile",
  activate(api) {
    __host("ui.panel", JSON.stringify(["another", "foreign", "Foreign", 0, [], 0]));
  },
});`;

const folder = mkdtempSync(join(tmpdir(), "lightcode-owner-"));
const w = await openLightcode({
  folder,
  before: (w: Lightcode) => {
    w.js.extra = [new PluginSource("hostile.js", hostile)];
  },
});
ok("a direct __host call cannot register another plugin's panel", !w.host.kernel.has("hostile") && w.host.kernel.problems.some((p) => p.startsWith("hostile:") && p.includes("did not come through")));
w.host.kernel.stop();
w.js.stopWatching();
w.host.workspace.close();
rmSync(folder, { recursive: true, force: true });
done();
