import { mean, median, range } from "./src/stats.mjs";

let failed = 0;
const eq = (name, got, want) => {
  if (got !== want) {
    failed++;
    console.log("FAIL " + name + ": got " + got + ", want " + want);
  } else console.log("ok " + name);
};
eq("mean of 2, 4, 6", mean([2, 4, 6]), 4);
eq("median of 3, 1, 2", median([3, 1, 2]), 2);
eq("range of 5, 1, 9", range([5, 1, 9]), 8);
process.exit(failed > 0 ? 1 : 0);
