// Passes when list prints as before and list --json prints the todos as JSON.
import { execFileSync } from "node:child_process";
const text = execFileSync("node", ["todo.mjs", "list"], { encoding: "utf8" });
if (text !== "[x] 1 write the plan\n[ ] 2 build it\n[ ] 3 measure it\n") { console.log("list changed: " + JSON.stringify(text)); process.exit(1); }
let parsed;
try { parsed = JSON.parse(execFileSync("node", ["todo.mjs", "list", "--json"], { encoding: "utf8" })); } catch (e) { console.log("list --json is not JSON: " + e.message); process.exit(1); }
const want = [{ id: 1, title: "write the plan", done: true }, { id: 2, title: "build it", done: false }, { id: 3, title: "measure it", done: false }];
if (JSON.stringify(parsed) !== JSON.stringify(want)) { console.log("list --json gave " + JSON.stringify(parsed)); process.exit(1); }
console.log("ok");
