// P-C (paths): the same import through a tsconfig `paths` alias.
import { signal, effect } from "@lightstart/light/signals/index.js";

const s = signal("x");
let last = "";
effect(() => {
  last = s.value;
});
s.value = "y";
console.log("paths import of light signals:", last);
