// Passes when answer.txt holds the retry count the settings work out to.
import { existsSync, readFileSync } from "node:fs";
if (!existsSync("answer.txt")) { console.log("no answer.txt"); process.exit(1); }
const got = readFileSync("answer.txt", "utf8").trim();
if (got !== "6") { console.log("answer.txt says " + JSON.stringify(got)); process.exit(1); }
console.log("ok");
