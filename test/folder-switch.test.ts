// ffi: @lightstart/plugins/native/ffi.json
// Another folder opened: its own project plugins replace the previous folder's, its config applies,
// and the previous folder's plugins stop (their commands and tabs go). A later switch back reads
// the first folder's plugins again.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Widecode } from "../src/compose.ts";
import { currentWidecode, openWidecode } from "./support/app.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const plugin = (id: string): string => `widecode.plugin({
  id: "${id}",
  defaults: () => ({ greeting: "${id}" }),
  activate(api) {
    const greeting = String((api.settings.section() ?? {}).greeting ?? "");
    api.commands.add({ name: "/which", run: () => api.tell("${id}") });
    api.commands.add({ name: "/greet", run: () => api.tell(greeting) });
  },
});`;

/** A folder with one project plugin and its config. */
const project = (root: string, id: string): string => {
  const dir = join(root, ".widecode");
  mkdirSync(join(dir, "plugins"), { recursive: true });
  writeFileSync(join(dir, "plugins", id + ".js"), plugin(id));
  writeFileSync(join(dir, "config.json"), '{"plugins":{' + JSON.stringify(id) + ':{"greeting":' + JSON.stringify("hello " + id) + "}}}");
  return join(dir, "plugins");
};

const main = async (): Promise<void> => {
  const folderA = mkdtempSync(join(tmpdir(), "widecode-switch-a-"));
  const folderB = mkdtempSync(join(tmpdir(), "widecode-switch-b-"));
  const dirA = project(folderA, "pa");
  const dirB = project(folderB, "pb");
  // The folder's own plugins, whichever folder the app opens: an /open starts it again there.
  let w = await openWidecode({
    folder: folderA,
    load: true,
    before: async (w: Widecode) => {
      await w.host.useStore(null);
      w.js.dirs = [w.host.harness.pluginsDir()];
    },
  });

  const tell = (text: string): string => {
    w.host.kernel.commands.run(text);
    return w.host.screen.message.peek();
  };
  eq("the first folder's plugin and its section", tell("/which") + " " + tell("/greet"), "pa hello pa");

  await w.host.openFolder(folderB);
  w = currentWidecode();
  ok("the previous folder's plugin went", !w.host.kernel.has("pa"));
  ok("the new folder's plugin came", w.host.kernel.has("pb"));
  ok("its folders are the watched ones", w.js.dirs.includes(dirB) && !w.js.dirs.includes(dirA));
  eq("the new folder's command and config", tell("/which") + " " + tell("/greet"), "pb hello pb");

  await w.host.openFolder(folderA);
  w = currentWidecode();
  ok("back: the first folder's plugin again", w.host.kernel.has("pa") && !w.host.kernel.has("pb"));
  eq("and its section", tell("/which") + " " + tell("/greet"), "pa hello pa");

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
