// Passes when src/lts.mjs names every line that has reached LTS status (24 Krypton since
// 2025-10-28, 26 Lithium since 2026-10-28, per nodejs.org/dist/index.json) and no line that has not.
import { pathToFileURL } from "node:url";
const { codename, newestLts } = await import(pathToFileURL("src/lts.mjs").href + "?" + Date.now());
const want = { 14: "Fermium", 16: "Gallium", 18: "Hydrogen", 20: "Iron", 22: "Jod", 24: "Krypton", 26: "Lithium" };
for (const [major, name] of Object.entries(want)) {
  if (codename(Number(major)) !== name) { console.log("codename(" + major + ") gave " + JSON.stringify(codename(Number(major))) + ", want " + JSON.stringify(name)); process.exit(1); }
}
for (const major of [23, 25, 27]) {
  if (codename(major) !== undefined) { console.log("codename(" + major + ") gave " + JSON.stringify(codename(major)) + ", but that line has no LTS status"); process.exit(1); }
}
if (newestLts() !== 26) { console.log("newestLts() gave " + String(newestLts()) + ", want 26"); process.exit(1); }
console.log("ok");
