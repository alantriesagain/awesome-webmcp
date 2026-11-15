// Passes when the config carries the file's currency and the catalog renders in it.
import { execFileSync } from "node:child_process";
const { loadConfig } = await import(process.cwd() + "/src/config/load.mjs");
const settings = loadConfig(process.cwd() + "/config.json");
if (settings.currency !== "EUR") { console.log("the currency loads as " + JSON.stringify(settings.currency)); process.exit(1); }
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" });
const want = [["Notebook", 12.5], ["Pen", 2], ["Lamp", 39.99]].map(([name, price]) => name + ": " + money.format(price)).join("\n") + "\n";
let out;
try { out = execFileSync("node", ["src/index.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { console.log("src/index.mjs failed: " + String(e.stderr || e.message).split("\n")[0]); process.exit(1); }
if (out !== want) { console.log("the catalog printed " + JSON.stringify(out)); process.exit(1); }
console.log("ok");
