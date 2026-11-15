// Passes when the script is there, the version is 1.4.3, and nothing else changed.
import { readFileSync } from "node:fs";
let p;
try { p = JSON.parse(readFileSync("package.json", "utf8")); } catch (e) { console.log("package.json is not JSON: " + e.message); process.exit(1); }
const want = { name: "bench-app", version: "1.4.3", private: true, type: "module", scripts: { start: "node src/index.mjs", test: "node --test", lint: "eslint ." }, dependencies: { chalk: "^5.3.0" } };
/** `v` as JSON with every object's keys sorted. */
const sorted = (v) => (Array.isArray(v) ? "[" + v.map(sorted).join(",") + "]" : v !== null && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + sorted(v[k])).join(",") + "}" : JSON.stringify(v));
if (sorted(p) !== sorted(want)) { console.log("package.json is " + JSON.stringify(p)); process.exit(1); }
console.log("ok");
