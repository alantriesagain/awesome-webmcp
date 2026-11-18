// What follows a signal from outside a view: a call after each change of its value, never for the
// value it holds when it starts, and a hook plugins hear the change on. A listener that changes the
// state it hears is heard again after it returns, never nested; one turn delivers a hook at most
// `TURN_MAX` times, so a listener that keeps changing it stops there, and the log says so.
import { effect, untracked } from "@lightstart/light/signals";
import { Hook } from "@lightstart/lib/hook.ts";
import { log } from "@lightstart/lib/log.ts";

/** How many times one turn delivers a hook made by `hookOn`: the first change and eight a listener made. */
const TURN_MAX = 9;

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
  let delivered = 0;
  afterChange(state, () => {
    if (delivered === 0) setTimeout(() => (delivered = 0), 0);
    delivered++;
    if (delivered === TURN_MAX + 1) log("plugins: dropped re-entrant \"" + name + "\" changes past " + String(TURN_MAX) + " in one turn: a listener keeps changing what it hears");
    if (delivered > TURN_MAX) return;
    hook.fire();
  });
  return hook;
};
