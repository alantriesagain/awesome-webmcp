// Passes when the tiers are right on their boundaries and the test runs green unchanged.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const { tierFor } = await import(process.cwd() + "/src/tiers.mjs");
const cases = [
  [-1, "invalid"], [0, "bronze"], [499, "bronze"], [500, "silver"],
  [1499, "silver"], [1500, "gold"], [2999, "gold"], [3000, "platinum"], [99999, "platinum"],
];
const bad = [];
for (const [points, want] of cases) {
  let got;
  try { got = tierFor(points); } catch (e) { got = "threw " + e.message; }
  if (got !== want) bad.push(String(points) + " gave " + JSON.stringify(got) + ", want " + JSON.stringify(want));
}
if (bad.length > 0) { console.log("wrong tier: " + bad.join("; ")); process.exit(1); }
const run = spawnSync("node", ["test.mjs"], { encoding: "utf8" });
if (run.status !== 0) { console.log("the test still fails: " + (run.stdout || "").split("\n").filter((l) => l.startsWith("FAIL")).slice(0, 3).join(" ")); process.exit(1); }
const given = readFileSync(fileURLToPath(new URL("repo/test.mjs", import.meta.url)), "utf8");
if (readFileSync("test.mjs", "utf8") !== given) { console.log("test.mjs was changed"); process.exit(1); }
console.log("ok");
