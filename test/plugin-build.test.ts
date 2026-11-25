// ffi: @lightstart/plugins/native/ffi.json
// A built-in plugin's folder carries the build it belongs to (.lightcode-build): a running binary
// reloads only the plugins of its own build, keeps the ones running from another build and says
// once to restart; a first start with another build's folder still loads it and says so; a folder
// with no stamp (the user's own plugin) reloads as before.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lightcode } from "../src/compose.ts";
import { BUILD_STAMP } from "../src/runtime/build-stamp.ts";
import { BUILD_VERSION } from "../src/runtime/build-info.ts";
import { done, eq, eqn } from "@lightstart/test/assert.ts";
import { openLightcode } from "./support/app.ts";

const plugin = (version: string): string => `lightcode.plugin({ id: "built", activate(api) {
  api.commands.add({ name: "/s", run: () => api.tell("${version}") });
} });`;

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "lightcode-build-"));
  const dir = join(folder, ".lightcode", "plugins");
  const built = join(dir, "built");
  const index = join(built, "index.js");
  const stamp = join(built, BUILD_STAMP);
  mkdirSync(built, { recursive: true });
  writeFileSync(index, plugin("v1"));
  writeFileSync(stamp, BUILD_VERSION + "\n");
  const logs: string[] = [];
  const w = await openLightcode({
    folder,
    load: true,
    before: (w: Lightcode) => {
      w.js.dirs = [dir];
      w.host.onLog = (text: string) => logs.push(text);
    },
  });
  const say = (): string => {
    w.host.roles.chat.submit("/s");
    return w.host.screen.message.peek();
  };
  eq("its own build's plugin loads and runs", say(), "v1");

  writeFileSync(index, plugin("v2"));
  writeFileSync(stamp, "a-newer-build\n");
  w.js.syncFolder(dir);
  eq("a plugin of another build is not reloaded, and it says to restart", w.host.screen.message.peek(), "a newer lightcode was installed: restart lightcode to use it (built)");
  eq("the plugin running is kept", say(), "v1");
  const said = (all: string[]): number => new Set(all.filter((l) => l.includes("restart lightcode")).map((l) => l.replace(/^plugins: /, ""))).size;
  eqn("it said so once", said(logs), 1);
  w.js.syncFolder(dir);
  eqn("and not again", said(logs), 1);
  eq("with the older plugin still running", say(), "v1");

  writeFileSync(index, plugin("v3"));
  writeFileSync(stamp, BUILD_VERSION + "\n");
  w.js.syncFolder(dir);
  eq("a folder stamped with its own build reloads", say(), "v3");

  writeFileSync(index, plugin("v4"));
  rmSync(stamp);
  w.js.syncFolder(dir);
  eq("a folder with no stamp reloads as before", say(), "v4");

  writeFileSync(index, plugin("v0"));
  writeFileSync(stamp, "a-newer-build\n");
  const firstLogs: string[] = [];
  const fresh = await openLightcode({
    folder,
    load: true,
    before: (next: Lightcode) => {
      next.js.dirs = [dir];
      next.host.onLog = (text: string) => firstLogs.push(text);
    },
  });
  fresh.host.roles.chat.submit("/s");
  eq("a first start still loads another build's plugin", fresh.host.screen.message.peek(), "v0");
  eqn("and says once to restart", new Set(firstLogs.filter((l) => l.includes("restart lightcode")).map((l) => l.replace(/^plugins: /, ""))).size, 1);

  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
