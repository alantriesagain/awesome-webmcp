// Passes when mapLimit keeps to its limit, keeps the order, and rejects with the first error.
const { mapLimit } = await import(process.cwd() + "/src/pool.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let inFlight = 0, most = 0;
const job = async (n) => { inFlight++; most = Math.max(most, inFlight); await sleep(n % 3 === 0 ? 30 : 5); inFlight--; return n * 2; };
const got = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, job);
const bad = [];
if (JSON.stringify(got) !== JSON.stringify([2, 4, 6, 8, 10, 12, 14, 16, 18])) bad.push("the results: " + JSON.stringify(got));
if (most > 3) bad.push(String(most) + " calls in flight at once, the limit is 3");
if (most < 2) bad.push("only " + String(most) + " call in flight at once: nothing ran together");
const empty = await mapLimit([], 2, job);
if (JSON.stringify(empty) !== "[]") bad.push("no items gave " + JSON.stringify(empty));
let error = "";
try { await mapLimit([1, 2, 3], 2, async (n) => { await sleep(5); if (n === 2) throw new Error("two"); return n; }); } catch (e) { error = e.message; }
if (error !== "two") bad.push("the error: " + JSON.stringify(error));
if (bad.length > 0) { console.log(bad.join("\n")); process.exit(1); }
console.log("ok");
