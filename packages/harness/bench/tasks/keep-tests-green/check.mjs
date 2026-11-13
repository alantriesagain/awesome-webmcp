// Passes when the existing tests still pass unchanged and combined and day intervals parse.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const run = spawnSync("node", ["test.mjs"], { encoding: "utf8" });
if (run.status !== 0) { console.log("the existing tests fail: " + (run.stdout || "").split("\n").filter((l) => l.startsWith("FAIL")).slice(0, 2).join(" ")); process.exit(1); }
const given = readFileSync(fileURLToPath(new URL("repo/test.mjs", import.meta.url)), "utf8");
if (readFileSync("test.mjs", "utf8") !== given) { console.log("test.mjs was changed"); process.exit(1); }
const { parseInterval } = await import(process.cwd() + "/src/interval.mjs");
const cases = [
  ["1d", 86400], ["1d12h", 129600], ["2h30m", 9000], ["1h15m30s", 4530],
  ["10m5s", 605], ["3d2h1m4s", 266464], ["90m", 5400],
];
const bad = [];
for (const [text, want] of cases) {
  let got;
  try { got = parseInterval(text); } catch (e) { got = "threw " + e.message; }
  if (got !== want) bad.push(JSON.stringify(text) + " gave " + JSON.stringify(got) + ", want " + want);
}
for (const text of ["1h30", "d", "1h 30m", "h30m"]) {
  try { const got = parseInterval(text); bad.push(JSON.stringify(text) + " gave " + JSON.stringify(got) + ", want a throw"); } catch { }
}
if (bad.length > 0) { console.log(bad.join("\n")); process.exit(1); }
console.log("ok");
