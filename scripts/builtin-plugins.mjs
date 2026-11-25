// The built-in JS plugins as normal files: each plugins/<id>/ (type-checked against lightcode.d.ts
// with the rest of the repository) goes into dist/plugins/<id>/, every .ts of it as .js with its
// types stripped by node and its relative imports of .ts files naming the .js, so the runtime loads
// it as ES modules, the way it loads the user's plugin folders. A development build takes its
// built-ins from there, beside it; `light install` writes them into the user's plugin folder. A test
// run writes them into dist/plugins-test/ instead, and the tests read them there, so a test's prepare
// never restamps the tree a build installs. The plugin guide (PLUGINS.md) and the API's types (lightcode.d.ts) go into
// src/runtime/docs.ts, for the harness plugin's api tool: the installed binary has no repository.
// The build's version (git describe of the workspace, else the package's version) and time go into
// src/runtime/build-info.ts, so a running binary says which build it is.
//
// For a test run (light's LIGHT_NATIVE_COMMAND is "test") docs.ts reads PLUGINS.md and lightcode.d.ts
// and, while no build has written build-info.ts, it says "test", so their text stays the same while
// the docs and the clock change: scriptc's cache keys a program by its text, so a minute passing
// compiles no test again. A build's build-info.ts is left as it is, so a test run cannot report "test"
// for a binary a build is compiling.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative } from "node:path";

const forTest = process.env.LIGHT_NATIVE_COMMAND === "test";
/** Write `text` to `path` only when it changes, so its time moves only then. */
const keep = (path, text) => {
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
};
const dir = "plugins";
/** The built-in plugins by id: a folder's index.ts (plugins/<id>/index.ts), or a file of its own (plugins/<id>.ts). */
const files = (existsSync(dir) ? readdirSync(dir).sort() : [])
  .map((f) => (f.endsWith(".ts") ? { id: f.slice(0, -3), path: join(dir, f) } : existsSync(join(dir, f, "index.ts")) ? { id: f, path: join(dir, f, "index.ts") } : null))
  .filter((f) => f !== null);
/** The languages plugin's list, from the package's one table. */
const languagesOf = (code) => {
  const table = readFileSync("node_modules/@lightstart/highlight/grammar.ts", "utf8");
  const re = /\{ id: "([^"]+)", extensions: (\[[^\]]*\]), fences: (\[[^\]]*\]),/g;
  const lines = [];
  for (let m = re.exec(table); m !== null; m = re.exec(table)) lines.push("  { id: " + JSON.stringify(m[1]) + ", extensions: " + m[2] + ", fences: " + m[3] + ", tokenizer: " + JSON.stringify(m[1]) + " },");
  return code.replace(/const LANGUAGES(?:: [^=]+)? = \[\n[\s\S]*?\n\];/, "const LANGUAGES = [\n" + lines.join("\n") + "\n];");
};

/** A plugin's files under `dir`, relative, by name (its subfolders' too). */
const filesIn = (dir, base = dir) => {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...filesIn(path, base));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) found.push(relative(base, path));
  }
  return found;
};
const versionOf = () => {
  try {
    return execFileSync("git", ["describe", "--always", "--dirty", "--tags"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return String(JSON.parse(readFileSync("package.json", "utf8")).version ?? "0");
  }
};
/** The build these plugins belong to: the binary's own (src/runtime/build-info.ts), stamped into each folder. */
const versionIn = () => {
  try {
    const m = /export const BUILD_VERSION: string = ("(?:[^"\\]|\\.)*");/.exec(readFileSync("src/runtime/build-info.ts", "utf8"));
    return m !== null ? JSON.parse(m[1]) : "";
  } catch {
    return "";
  }
};
const existingVersion = forTest ? versionIn() : "";
const buildVersion = forTest ? (existingVersion.length > 0 ? existingVersion : "test") : versionOf();
const tree = forTest ? "dist/plugins-test" : "dist/plugins";
for (const f of files) {
  const folder = f.path.endsWith("/index.ts") ? dirname(f.path) : null;
  const names = folder !== null ? filesIn(folder) : [f.path.slice(dir.length + 1)];
  for (const name of names) {
    let source = readFileSync(folder !== null ? join(folder, name) : f.path, "utf8");
    if (f.id === "languages" && name === "index.ts") source = languagesOf(source);
    const code = stripTypeScriptTypes(source).replace(/(from\s+|import\s+|import\()(["'])(\.{1,2}\/[^"']*)\.ts\2/g, "$1$2$3.js$2");
    const target = join(tree, f.id, folder !== null ? name.replace(/\.ts$/, ".js") : "index.js");
    mkdirSync(dirname(target), { recursive: true });
    keep(target, code);
  }
  keep(join(tree, f.id, ".lightcode-build"), buildVersion + "\n");
}

const docsOut = "src/runtime/docs.ts";
const docs = forTest
  ? "// Generated by scripts/builtin-plugins.mjs (run from the app) for a test run: the files are read when the program starts.\n" +
    'import { readTextOr } from "@lightstart/lib/fs.ts";\n\n' +
    "/** The plugin guide (PLUGINS.md), read from the app's folder. */\n" +
    'export const PLUGIN_GUIDE: string = readTextOr("PLUGINS.md", "");\n\n' +
    "/** The plugin API's types (lightcode.d.ts). */\n" +
    'export const PLUGIN_TYPES: string = readTextOr("lightcode.d.ts", "");\n'
  : "// Generated by scripts/builtin-plugins.mjs (run from the app) from PLUGINS.md and lightcode.d.ts: edit those, not this.\n\n" +
  "/** The plugin guide (PLUGINS.md), as the binary carries it for the harness plugin's api tool. */\n" +
  "export const PLUGIN_GUIDE: string = " + JSON.stringify(readFileSync("PLUGINS.md", "utf8")) + ";\n\n" +
  "/** The plugin API's types (lightcode.d.ts). */\n" +
  "export const PLUGIN_TYPES: string = " + JSON.stringify(readFileSync("lightcode.d.ts", "utf8")) + ";\n";
keep(docsOut, docs);

const infoOut = "src/runtime/build-info.ts";
const info =
  "// Generated by scripts/builtin-plugins.mjs (run from the app) at build time: edit nothing here.\n\n" +
  "/** The build: the workspace's git describe (a tag, the commits past it, the commit, -dirty), else the package's version. */\n" +
  "export const BUILD_VERSION: string = " + JSON.stringify(buildVersion) + ";\n\n" +
  "/** When it was built (ISO, to the minute). */\n" +
  "export const BUILD_TIME: string = " + JSON.stringify(forTest ? "test" : new Date().toISOString().slice(0, 16) + "Z") + ";\n";
// A test run leaves a build's build-info.ts alone: its stamps take that build's version, and a build compiling beside the test keeps reporting its own.
if (!forTest || !existsSync(infoOut)) keep(infoOut, info);
