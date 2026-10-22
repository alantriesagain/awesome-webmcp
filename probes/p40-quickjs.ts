// QuickJS embedded in a scriptc binary through the FFI (apps/widecode/native: the shim, its archive
// and manifest): a script evaluated, a plugin's call into the host answered by a reply, the host
// invoking a plugin's function, promise jobs, a host call that calls back into JS, an error with
// its stack, a runaway loop stopped by the time budget, the memory limit, the engine usable after
// each, and what 10k round trips cost. Native only: `scriptc run --ffi apps/widecode/native/ffi.json`.
declare function wcjsNew(memoryMb: number, budgetMs: number): bigint;
declare function wcjsFree(ctx: bigint): void;
declare function wcjsSetHost(ctx: bigint, host: (name: string, args: string) => number): void;
declare function wcjsReply(ctx: bigint, json: string): void;
declare function wcjsEval(ctx: bigint, code: string, file: string, done: (status: number, text: string) => void): number;
declare function wcjsInvoke(ctx: bigint, id: number, json: string, done: (status: number, text: string) => void): number;
declare function wcjsJobs(ctx: bigint, done: (status: number, text: string) => void): number;

const ctx = wcjsNew(32, 250);
let calls = 0;
const host = (name: string, args: string): number => {
  calls++;
  if (name === "echo") {
    wcjsReply(ctx, args);
    return 0;
  }
  if (name === "nested") {
    // The host, inside a plugin's call, calls the plugin's function 1 and answers with its result.
    let inner = "";
    wcjsInvoke(ctx, 1, args, (_status: number, text: string) => {
      inner = text;
    });
    wcjsReply(ctx, inner);
    return 0;
  }
  wcjsReply(ctx, "no such call: " + name);
  return 1;
};
wcjsSetHost(ctx, host);

const run = (code: string): string => {
  let out = "";
  wcjsEval(ctx, code, "probe.js", (status: number, text: string) => {
    out = String(status) + " " + text;
  });
  return out;
};
const invoke = (id: number, json: string): string => {
  let out = "";
  wcjsInvoke(ctx, id, json, (status: number, text: string) => {
    out = String(status) + " " + text;
  });
  return out;
};
const firstLine = (s: string): string => s.split("\n")[0];

console.log("eval: " + run("1 + 2"));
console.log("a string as is: " + run("'héllo ✓'"));
console.log("host round trip: " + run("__host('echo', JSON.stringify({ a: 1, s: 'é' }))"));
console.log("a host error throws in JS: " + run("try { __host('nope', '{}') } catch (e) { 'caught ' + e.message }"));
run("globalThis.__fns = []; globalThis.__invoke = (id, json) => JSON.stringify(__fns[id](JSON.parse(json)));");
run("__fns[0] = (x) => ({ doubled: x.n * 2 }); __fns[1] = (x) => ({ inner: x.v + 1 });");
console.log("invoke: " + invoke(0, '{"n": 21}'));
console.log("nested: " + run("__host('nested', JSON.stringify({ v: 41 }))"));
run("globalThis.done = 'no'; Promise.resolve().then(() => { done = 'yes'; });");
console.log("before jobs: " + run("done"));
const ran = wcjsJobs(ctx, (status: number, text: string) => console.log("job error " + String(status) + " " + firstLine(text)));
console.log("jobs ran: " + String(ran) + ", after: " + run("done"));
const err = run("function boom() { throw new Error('boom'); }\nboom();");
console.log("error: " + firstLine(err) + " | stack names the function: " + String(err.includes("at boom")));
const t0 = Date.now();
const loop = run("for (;;) {}");
const loopMs = Date.now() - t0;
console.log("runaway loop: status " + loop.slice(0, 1) + ", stopped near the budget: " + String(loopMs >= 240 && loopMs < 1000));
console.log("usable after: " + run("40 + 2"));
const t1 = Date.now();
let lastInvoke = "";
for (let i = 0; i < 10000; i++) lastInvoke = invoke(0, '{"n": 1}');
const invokeMs = Date.now() - t1;
const t2 = Date.now();
const loopOut = run("let n = 0; const arg = JSON.stringify({ x: 1 }); for (let i = 0; i < 10000; i++) n += JSON.parse(__host('echo', arg)).x; n");
const hostMs = Date.now() - t2;
console.log("10k invokes: " + lastInvoke + " in " + String(invokeMs) + " ms; 10k host calls: " + loopOut + " in " + String(hostMs) + " ms; host calls seen: " + String(calls));
const mem = run("(() => { const big = []; for (let i = 0; i < 1e6; i++) big.push(new Array(1e4).fill(i)); return big.length; })()");
console.log("memory limit: status " + mem.slice(0, 1) + ", " + firstLine(mem.slice(2)));
console.log("usable after: " + run("'still here'"));
wcjsFree(ctx);
