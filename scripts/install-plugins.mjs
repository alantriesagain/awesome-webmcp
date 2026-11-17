// The built-in plugins installed with the binary (`light install`, as the native block's install
// step): dist/plugins/<id>/ (the prepare step's) into the user's plugin folder, $WIDECODE_HOME/plugins
// or ~/.widecode/plugins, each folder with .widecode-installed, the hash of what was written. A
// folder installed before and unchanged since is replaced; one the user edited since, or one of the
// user's own with a built-in's id, is left as it is and named; an installed one no longer built in
// and unchanged goes.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const MARK = ".widecode-installed";
const source = "dist/plugins";
const home = (process.env.WIDECODE_HOME ?? "").length > 0 ? process.env.WIDECODE_HOME : join(homedir(), ".widecode");
const target = join(home, "plugins");

/** The files under `dir`, relative, by name, the mark left out. */
const filesIn = (dir, base = dir) => {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesIn(path, base));
    else if (name !== MARK) out.push(relative(base, path));
  }
  return out;
};

/** The hash of a folder's files: their paths and contents. */
const hashOf = (dir) => {
  const h = createHash("sha256");
  for (const f of filesIn(dir)) h.update(f + "\0" + readFileSync(join(dir, f), "utf8") + "\0");
  return h.digest("hex");
};

const markOf = (dir) => (existsSync(join(dir, MARK)) ? readFileSync(join(dir, MARK), "utf8").trim() : null);

if (!existsSync(source)) {
  console.error("install-plugins: no " + source + "; the prepare step writes it (node --no-warnings scripts/builtin-plugins.mjs)");
  process.exit(1);
}
mkdirSync(target, { recursive: true });
const ids = readdirSync(source).filter((id) => statSync(join(source, id)).isDirectory()).sort();
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
