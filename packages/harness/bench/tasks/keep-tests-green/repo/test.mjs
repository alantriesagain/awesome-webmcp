import { parseInterval } from "./src/interval.mjs";

let failed = 0;
const eq = (text, want) => {
  try {
    const got = parseInterval(text);
    if (got === want) console.log("ok " + text);
    else { failed++; console.log("FAIL " + text + ": got " + got + ", want " + want); }
  } catch (e) {
    failed++;
    console.log("FAIL " + text + ": threw " + e.message);
  }
};
const throws = (text) => {
  try { parseInterval(text); failed++; console.log("FAIL " + text + ": did not throw"); }
  catch { console.log("ok " + text + " throws"); }
};

eq("45s", 45);
eq("5m", 300);
eq("2h", 7200);
eq("0s", 0);
throws("1x");
throws("");
throws("h");

console.log("done: " + String(failed) + " failed");
process.exit(failed > 0 ? 1 : 0);
