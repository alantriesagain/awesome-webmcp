// node-only
// The prepare step (scripts/builtin-plugins.mjs) stamps every built-in plugin folder it writes with
// the build it belongs to, the same id the binary reports (src/runtime/build-info.ts), so a running
// binary can tell a newer install's plugins from its own. Run in a folder of its own, so a test run
// does not restamp the tree's dist while other tests read it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_STAMP } from "../src/runtime/build-stamp.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const main = async (): Promise<void> => {
  const root = process.cwd();
  const folder = mkdtempSync(join(tmpdir(), "widecode-build-stamp-"));
  for (const name of ["plugins", "node_modules", "PLUGINS.md", "widecode.d.ts", "package.json"]) symlinkSync(join(root, name), join(folder, name));
  mkdirSync(join(folder, "src", "runtime"), { recursive: true });
  execFileSync(process.execPath, [join(root, "scripts", "builtin-plugins.mjs")], { cwd: folder, env: { ...process.env, LIGHT_NATIVE_COMMAND: "test" }, stdio: "ignore" });
  const tree = join(folder, "dist", "plugins-test");
  const ids = readdirSync(tree)
    .filter((id) => statSync(join(tree, id)).isDirectory())
    .sort();
  ok("the prepare step writes the built-in plugins", ids.length > 0);
  // A test run's binary reports "test" (src/runtime/build-info.ts), so the stamp says the same.
  for (const id of ids) {
    eq("stamped with the build's own id: " + id, readFileSync(join(tree, id, BUILD_STAMP), "utf8").trim(), "test");
  }
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
