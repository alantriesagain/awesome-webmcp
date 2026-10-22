// A program that imports light's terminal tree (tdom/index.ts) and also holds a function that
// returns a Promise it never awaits fails to link natively: the code references
// `scr_dyn_new_promise_adapting` (from a module loader's materialization) but the runtime object
// that defines it (`scr_async_dyn.o`) is not selected. Without tdom, or once the Promise is
// awaited somewhere, it links. Workaround in apps/widecode: keep pure models out of modules that
// import light. Prints the same under node and natively once it links.
import { TRoot } from "../../light/tdom/index.ts";

export const later = (n: number): Promise<number> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(n), 1);
  });

console.log("linked " + typeof TRoot + " " + typeof later);
