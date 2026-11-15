// Passes when the release stage parses where asked, the file keeps tabs, and the printout matches.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const { parsePipeline } = await import(process.cwd() + "/src/pipeline.mjs");
const text = readFileSync("pipeline.pipe", "utf8");
for (const line of text.split("\n")) {
  if (line.trim() !== "" && /^ /.test(line)) { console.log("a line begins with spaces: " + JSON.stringify(line)); process.exit(1); }
}
const want = [
  { name: "build", steps: [{ name: "compile", substeps: [] }, { name: "bundle", substeps: [] }] },
  { name: "test", steps: [{ name: "unit", substeps: [] }, { name: "integration", substeps: [] }] },
  { name: "release", steps: [{ name: "package", substeps: ["checksum"] }, { name: "publish", substeps: [] }] },
  { name: "deploy", steps: [{ name: "package", substeps: [] }, { name: "publish", substeps: [] }] },
];
let got;
try { got = parsePipeline(text); } catch (e) { console.log("pipeline.pipe does not parse: " + e.message); process.exit(1); }
if (JSON.stringify(got) !== JSON.stringify(want)) { console.log("the stages are " + JSON.stringify(got)); process.exit(1); }
const out = execFileSync("node", ["src/print.mjs"], { encoding: "utf8" });
const lines = "build\n  compile\n  bundle\ntest\n  unit\n  integration\nrelease\n  package\n    checksum\n  publish\ndeploy\n  package\n  publish\n";
if (out !== lines) { console.log("the printout is " + JSON.stringify(out)); process.exit(1); }
console.log("ok");
