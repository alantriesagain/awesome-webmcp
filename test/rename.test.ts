// lightcode was widecode (src/services/rename.ts): ~/.widecode becomes the store and a project's
// .widecode/ its .lightcode/, each by one rename the first time it is looked for, and nothing moves
// when the new one is already there or the old one is not.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveOldStore, projectFolder } from "../src/services/rename.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const base = mkdtempSync(join(tmpdir(), "lightcode-rename-"));

// A project with only widecode's folder: it is renamed, its files in it.
const project = join(base, "project");
mkdirSync(join(project, ".widecode"), { recursive: true });
writeFileSync(join(project, ".widecode", "prompt.md"), "kept\n");
eq("a project's .lightcode/ is answered", projectFolder(project), join(project, ".lightcode"));
ok("its .widecode/ moved there, with what it held", !existsSync(join(project, ".widecode")) && readFileSync(join(project, ".lightcode", "prompt.md"), "utf8") === "kept\n");
eq("asked again, the same folder", projectFolder(project), join(project, ".lightcode"));

// A project with both: neither is touched.
const both = join(base, "both");
mkdirSync(join(both, ".widecode"), { recursive: true });
mkdirSync(join(both, ".lightcode"), { recursive: true });
projectFolder(both);
ok("with both folders there, both stay", existsSync(join(both, ".widecode")) && existsSync(join(both, ".lightcode")));

// A project with neither: nothing is made.
const none = join(base, "none");
mkdirSync(none);
projectFolder(none);
ok("with neither, nothing is made", !existsSync(join(none, ".lightcode")));

// The store: ~/.widecode renamed to the new root once, saying so.
const home = join(base, "home");
mkdirSync(join(home, ".widecode"), { recursive: true });
writeFileSync(join(home, ".widecode", "config.json"), "{}\n");
const root = join(home, ".lightcode");
eq("widecode's store moved, and the move said", moveOldStore(root, home), "moved ~/.widecode to " + root);
ok("its files in the new store", readFileSync(join(root, "config.json"), "utf8") === "{}\n" && !existsSync(join(home, ".widecode")));
eq("a second start moves nothing", moveOldStore(root, home), "");

rmSync(base, { recursive: true, force: true });
done();
