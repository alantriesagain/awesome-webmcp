// P-C (relative): a TypeScript program importing light's JavaScript signals by relative path.
import { signal, computed, effect, batch } from "../../../light/signals/index.js";

const a = signal(1);
const b = computed(() => a.value * 2);
const seen: number[] = [];
effect(() => {
  seen.push(b.value);
});
batch(() => {
  a.value = 2;
  a.value = 3;
});
console.log("relative import of light signals:", seen.join(","));
