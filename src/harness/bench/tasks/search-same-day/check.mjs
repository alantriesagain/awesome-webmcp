// Passes when answer.txt holds the last Node.js 26 release before the day pi-coding-agent 1.5.2 was
// published (npm: 2026-11-10; nodejs.org/dist/index.json: v26.13.0 on 2026-10-28, then v26.13.1 dated
// 2026-11-10 there and 2026-11-11 in its changelog, so "before" holds either way).
import { existsSync, readFileSync } from "node:fs";
if (!existsSync("answer.txt")) { console.log("no answer.txt"); process.exit(1); }
const got = readFileSync("answer.txt", "utf8").trim();
if (got !== "v26.13.0") { console.log("answer.txt says " + JSON.stringify(got)); process.exit(1); }
console.log("ok");
