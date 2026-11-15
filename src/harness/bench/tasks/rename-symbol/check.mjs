// Passes when no file names fetchUserName, users.mjs exports loadUserName, and the output is the same.
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const left = readdirSync("src").filter((f) => readFileSync("src/" + f, "utf8").includes("fetchUserName"));
if (left.length > 0) { console.log("still named in " + left.join(", ")); process.exit(1); }
const users = await import(process.cwd() + "/src/users.mjs");
if (typeof users.loadUserName !== "function") { console.log("users.mjs exports no loadUserName"); process.exit(1); }
const out = execFileSync("node", ["src/main.mjs"], { encoding: "utf8" });
if (out !== "Hello, Ada!\n2: Grace\n3: Linus\n4: unknown\n") { console.log("the output changed: " + JSON.stringify(out)); process.exit(1); }
console.log("ok");
