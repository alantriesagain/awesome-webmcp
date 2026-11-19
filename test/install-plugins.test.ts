// node-only
// The install step copies dist/plugins into the plugin folder only when the tree is the installed
// binary's own build: a test run's tree (or any other build's) is refused, so a stale restart warning
// cannot come from the install. Without LIGHT_INSTALLED (run by hand) it copies as before.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const script = join(process.cwd(), "scripts", "install-plugins.mjs");

class Case {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "widecode-install-"));
  }

  /** dist/plugins/built, stamped `stamp`. */
  source(stamp: string): void {
    const built = join(this.dir, "dist", "plugins", "built");
    mkdirSync(built, { recursive: true });
    writeFileSync(join(built, "index.js"), "widecode.plugin({ id: \"built\" });\n");
    writeFileSync(join(built, ".widecode-build"), stamp + "\n");
  }

  /** An executable that prints `building` the way the binary does. */
  binary(building: string): string {
    const path = join(this.dir, "widecode");
    writeFileSync(path, "#!/bin/sh\necho \"widecode " + building + " built 2026-01-01\"\n");
    chmodSync(path, 0o755);
    return path;
  }

  run(installed: string): { status: number; stderr: string; target: string } {
    const home = join(this.dir, "home");
    const r = spawnSync(process.execPath, [script], {
      cwd: this.dir,
      env: { ...process.env, WIDECODE_HOME: home, LIGHT_INSTALLED: installed },
      encoding: "utf8",
    });
    return { status: r.status ?? -1, stderr: r.stderr, target: join(home, "plugins") };
  }

  close(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const main = async (): Promise<void> => {
  const same = new Case();
  same.source("abc123");
  const installed = same.run(same.binary("abc123"));
  eq("a tree of the installed build installs", String(installed.status), "0");
  ok("its plugin is copied", existsSync(join(installed.target, "built", "index.js")));
  ok("with its own stamp", readFileSync(join(installed.target, "built", ".widecode-build"), "utf8").trim() === "abc123");
  same.close();

  const testTree = new Case();
  testTree.source("test");
  const testStamp = testTree.run(testTree.binary("abc123"));
  ok("a test run's tree refuses", testStamp.status !== 0);
  ok("and copies nothing", !existsSync(testStamp.target));
  ok("and says to install again", testStamp.stderr.includes("run `light install` again"));
  testTree.close();

  const otherTree = new Case();
  otherTree.source("zzz");
  const otherStamp = otherTree.run(otherTree.binary("abc123"));
  ok("another build's tree refuses", otherStamp.status !== 0);
  ok("and copies nothing", !existsSync(otherStamp.target));
  otherTree.close();

  const testBinary = new Case();
  testBinary.source("test");
  const testBuild = testBinary.run(testBinary.binary("test"));
  ok("a binary reporting test refuses", testBuild.status !== 0);
  ok("and copies nothing", !existsSync(testBuild.target));
  testBinary.close();

  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
