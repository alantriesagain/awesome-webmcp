// P5: cross-directory relative .ts imports compile as static program modules.
import { Counter, VERSION, twice } from "../b/lib.ts";

const c = new Counter();
c.bump();
c.bump();
console.log(VERSION, c.n, twice(c.n));
