// The built-in plugins installed with the binary (`light install`, as the native block's install
// step): dist/plugins/<id>/ (the prepare step's) into the user's plugin folder, $LIGHTCODE_HOME/plugins
// or ~/.lightcode/plugins, each folder with .lightcode-installed, the hash of what was written. A
// folder installed before and unchanged since is replaced; one the user edited since, or one of the
// user's own with a built-in's id, is left as it is and named; an installed one no longer built in
// and unchanged goes. Run by `light install` (LIGHT_INSTALLED names the binary) it first checks the
// tree is that binary's own build: a test run's stamp, or any other build's, copies nothing and fails,
// so a test running beside a build cannot install its plugins.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const MARK = ".lightcode-installed";
/** The mark widecode wrote, read in place of MARK until the folder is installed again. */
const OLD_MARK = ".widecode-installed";
const STAMP = ".lightcode-build";
const source = "dist/plugins";
const ownHome = (process.env.LIGHTCODE_HOME ?? "").length === 0;
const home = ownHome ? join(homedir(), ".lightcode") : process.env.LIGHTCODE_HOME;
// lightcode was widecode: its store moves to the new name before anything is written there, as the
// app does at start (src/services/rename.ts), so installing first does not leave it behind.
if (ownHome && !existsSync(home) && existsSync(join(homedir(), ".widecode"))) {
  renameSync(join(homedir(), ".widecode"), home);
  console.log("moved ~/.widecode to " + home);
}
const target = join(home, "plugins");

/** The files under `dir`, relative, by name, the mark left out. */
const filesIn = (dir, base = dir) => {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesIn(path, base));
    else if (name !== MARK && name !== OLD_MARK) out.push(relative(base, path));
  }
  return out;
};

/** The hash of a folder's files: their paths and contents. */
const hashOf = (dir) => {
  const h = createHash("sha256");
  for (const f of filesIn(dir)) h.update(f + "\0" + readFileSync(join(dir, f), "utf8") + "\0");
  return h.digest("hex");
};

const markOf = (dir) => {
  for (const name of [MARK, OLD_MARK]) if (existsSync(join(dir, name))) return readFileSync(join(dir, name), "utf8").trim();
  return null;
};

if (!existsSync(source)) {
  console.error("install-plugins: no " + source + "; the prepare step writes it (node --no-warnings scripts/builtin-plugins.mjs)");
  process.exit(1);
}
const ids = readdirSync(source).filter((id) => statSync(join(source, id)).isDirectory()).sort();
const installed = (process.env.LIGHT_INSTALLED ?? "").trim();
if (installed.length > 0) {
  let build = "";
  try {
    const out = execFileSync(installed, ["--version"], { encoding: "utf8" }).trim();
    const found = /^lightcode (\S+)/.exec(out);
    build = found !== null ? found[1] : "";
  } catch {
    build = "";
  }
  if (build === "test") {
    console.error("install-plugins: the installed binary reports test, a test run's build; run `light install` again with no test run going");
    process.exit(1);
  }
  const stampOf = (id) => {
    try {
      return readFileSync(join(source, id, STAMP), "utf8").trim();
    } catch {
      return "";
    }
  };
  const wrong = ids.filter((id) => stampOf(id) !== build);
  if (wrong.length > 0) {
    console.error("install-plugins: " + source + " is not the installed binary's build (" + (build.length > 0 ? build : "no version") + "): " + wrong.join(", ") + "; run `light install` again with no test run going");
    process.exit(1);
  }
}
mkdirSync(target, { recursive: true });
const written = [];
const left = [];
for (const id of ids) {
  const from = join(source, id);
  const to = join(target, id);
  const mark = existsSync(to) ? markOf(to) : null;
  if (existsSync(to) && mark === null) {
    left.push(id + " (yours)");
    continue;
  }
  if (mark !== null && hashOf(to) !== mark) {
    left.push(id + " (edited since it was installed)");
    continue;
  }
  const hash = hashOf(from);
  if (mark === hash) continue;
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  writeFileSync(join(to, MARK), hash + "\n");
  written.push(id);
}
const gone = [];
for (const id of existsSync(target) ? readdirSync(target).sort() : []) {
  const dir = join(target, id);
  if (ids.includes(id) || !statSync(dir).isDirectory()) continue;
  const mark = markOf(dir);
  if (mark !== null && hashOf(dir) === mark) {
    rmSync(dir, { recursive: true, force: true });
    gone.push(id);
  }
}
console.log("plugins in " + target + ": " + (written.length > 0 ? "installed " + written.join(", ") : "all up to date") + (gone.length > 0 ? "; removed " + gone.join(", ") : "") + (left.length > 0 ? "; left " + left.join(", ") : ""));
