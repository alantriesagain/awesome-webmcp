// Passes when answer.txt holds the first Node.js 26 release with LTS status (nodejs.org/dist/index.json: v26.13.0, 2026-10-28, Lithium).
import { existsSync, readFileSync } from "node:fs";
if (!existsSync("answer.txt")) { console.log("no answer.txt"); process.exit(1); }
const got = readFileSync("answer.txt", "utf8").trim();
if (got !== "v26.13.0") { console.log("answer.txt says " + JSON.stringify(got)); process.exit(1); }
console.log("ok");
