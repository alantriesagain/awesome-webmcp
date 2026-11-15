// Passes when every month prints all its days, leap February included.
import { execFileSync } from "node:child_process";
const months = [[2026, 2, 28], [2024, 2, 29], [2026, 4, 30], [2026, 1, 31], [2026, 12, 31], [2025, 2, 28]];
const bad = [];
for (const [year, month, count] of months) {
  const out = execFileSync("node", ["src/main.mjs", String(year), String(month)], { encoding: "utf8" });
  const lines = out.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const mm = String(month).padStart(2, "0");
  if (lines.length !== count) bad.push(year + "-" + mm + " printed " + String(lines.length) + " days, want " + String(count));
  else if (lines[0] !== year + "-" + mm + "-01") bad.push(year + "-" + mm + " starts at " + JSON.stringify(lines[0]));
  else if (lines[count - 1] !== year + "-" + mm + "-" + String(count).padStart(2, "0")) bad.push(year + "-" + mm + " ends at " + JSON.stringify(lines[count - 1]));
}
if (bad.length > 0) { console.log(bad.join("\n")); process.exit(1); }
console.log("ok");
