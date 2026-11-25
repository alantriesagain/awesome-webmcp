// ffi: @lightstart/plugins/native/ffi.json
// --trust: the folder's harness is put in use for this run after start, without keeping the trust.
// Its plugins load, its config applies, and the folder is watched, the same way /trust does it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLightcode } from "./support/app.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const plugin = `lightcode.plugin({
  id: "trusted",
  defaults: () => ({ greeting: "hi" }),
  activate(api) {
    const greeting = String((api.settings.section() ?? {}).greeting ?? "");
    api.commands.add({ name: "/trusted", run: () => api.tell(greeting) });
  },
});`;

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "lightcode-trust-run-"));
  const dir = join(folder, ".lightcode");
  mkdirSync(join(dir, "plugins"), { recursive: true });
  writeFileSync(join(dir, "plugins", "trusted.js"), plugin);
  writeFileSync(join(dir, "config.json"), '{"plugins":{"trusted":{"greeting":"the harness"}}}');
  const w = await openLightcode({ folder, load: true });
  ok("the folder starts untrusted, its harness out", !w.host.harness.trusted);
  ok("the project's plugin is out before the harness is used", !w.host.kernel.has("trusted"));
  ok("and its folder is not one of the plugin folders", !w.js.dirs.includes(join(dir, "plugins")));

  const note = w.useHarnessNow();
  ok("the folder is trusted for this run", w.host.harness.trusted);
  ok("its plugin is in use", w.host.kernel.has("trusted"));
  ok("its folder is watched", w.js.dirs.includes(join(dir, "plugins")));
  w.host.kernel.commands.run("/trusted");
  eq("its config applies" + (note.length > 0 ? " (" + note + ")" : ""), w.host.screen.message.peek(), "the harness");

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
