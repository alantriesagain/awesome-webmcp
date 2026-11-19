// Passes when answer.txt holds the day pi-coding-agent 1.5.2 was published (npm's time record: 2026-11-10T12:24Z).
import { existsSync, readFileSync } from "node:fs";
if (!existsSync("answer.txt")) { console.log("no answer.txt"); process.exit(1); }
const got = readFileSync("answer.txt", "utf8").trim();
if (got !== "2026-11-10") { console.log("answer.txt says " + JSON.stringify(got)); process.exit(1); }
console.log("ok");
