import { tierFor } from "./src/tiers.mjs";

let failed = 0;
const check = (points, want) => {
  const got = tierFor(points);
  if (got === want) {
    console.log("ok points=" + String(points) + " tier=" + got);
  } else {
    failed++;
    console.log("FAIL points=" + String(points) + " tier=" + got + ", want " + want);
  }
};

for (let points = 0; points < 5000; points++) {
  const want = points < 500 ? "bronze" : points < 1500 ? "silver" : points < 3000 ? "gold" : "platinum";
  check(points, want);
}
check(-1, "invalid");

console.log("done: " + String(failed) + " failed");
process.exit(failed > 0 ? 1 : 0);
