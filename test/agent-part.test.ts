// ffi: @lightstart/plugins/native/ffi.json
// A plugin with only an agent part: the app's prelude takes it as a plugin that registers nothing,
// the kernel lists it as on, and config.json's plugin section switches it off without an error.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSource } from "@lightstart/plugins/sources.ts";
import type { Widecode } from "../src/compose.ts";
import { done, ok } from "@lightstart/test/assert.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";

const gate = `widecode.plugin({
  id: "gate",
  agent(agent) {
    agent.on("tool_call", (event) => event.toolName === "Bash" ? { block: true, reason: "no" } : undefined);
  },
});`;

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-agent-part-"));
  const make = (config: string): Promise<Widecode> =>
    openWidecode({
      folder,
      plugins: JSON.parse(config),
      before: (w: Widecode) => {
        w.js.extra = [new PluginSource("gate.js", gate)];
      },
    });

  let w = await make("{}");
  ok("a plugin with only an agent part loads and is on", w.host.kernel.has("gate") && w.host.kernel.problems.length === 0 && w.js.errors.length === 0);
  ok("it registers nothing in the app", w.host.kernel.commands.find("/gate") === null);
  closeWidecode(w);

  w = await make('{"gate": false}');
  ok("switched off by its section, without an error", !w.host.kernel.has("gate") && w.host.kernel.problems.length === 0 && w.js.errors.length === 0);
  closeWidecode(w);

  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
