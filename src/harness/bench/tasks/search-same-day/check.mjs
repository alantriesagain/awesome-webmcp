// Passes when answer.txt holds the Node.js release of pi-coding-agent 1.5.2's day (both 2026-11-10: v26.13.1).
import { existsSync, readFileSync } from "node:fs";
if (!existsSync("answer.txt")) { console.log("no answer.txt"); process.exit(1); }
const got = readFileSync("answer.txt", "utf8").trim();
if (got !== "v26.13.1") { console.log("answer.txt says " + JSON.stringify(got)); process.exit(1); }
console.log("ok");
