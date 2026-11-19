// What follows a signal from outside a view: a call after each change of its value, never for the
// value it holds when it starts, and a hook plugins hear the change on. A listener that changes the
// state it hears is heard again after it returns, never nested; such re-deliveries stop after
// `RERUN_MAX` in a row, and the log says so. Changes made elsewhere are all delivered.
import { effect, untracked } from "@lightstart/light/signals";
import { Hook } from "@lightstart/lib/hook.ts";
import { log } from "@lightstart/lib/log.ts";

/** How many deliveries in a row a hook made by `hookOn` makes for changes its own listeners made. */
const RERUN_MAX = 8;

/** Call `onChange` after each change of `state`'s value (not for the value it has now); the answer stops it. */
export const afterChange = (state: { readonly value: unknown }, onChange: () => void): (() => void) => {
  let started = false;
  const e = effect(() => {
    state.value;
    if (!started) {
      started = true;
      return;
    }
    untracked(onChange);
  });
  return () => e.dispose();
};

/** A hook fired after each change of `state`, for the plugins that listen under `name`. */
export const hookOn = (name: string, state: { readonly value: unknown }): Hook => {
  const hook = new Hook();
  // The re-deliveries in a row, and whether the last delivery's listeners changed the state.
  let reruns = 0;
  let causedByListeners = false;
  afterChange(state, () => {
    reruns = causedByListeners ? reruns + 1 : 0;
    if (reruns > RERUN_MAX) {
      log("plugins: dropped a re-entrant \"" + name + "\" change past " + String(RERUN_MAX) + " re-runs: a listener keeps changing what it hears");
      causedByListeners = false;
      return;
    }
    const before = state.value;
    hook.fire();
    causedByListeners = state.value !== before;
  });
  return hook;
};

/** A hook fired for each value `occurrence` emits, for the plugins that listen under its name (the event's own queue keeps a listener's emits from nesting). */
export const hookOnEvent = (occurrence: { on(listener: () => void): () => void }): Hook => {
  const hook = new Hook();
  occurrence.on(() => hook.fire());
  return hook;
};
