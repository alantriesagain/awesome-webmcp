import { parseCsv } from "./src/csv.mjs";
let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? "ok " : "FAIL ") + name + (ok ? "" : ": got " + JSON.stringify(got)));
};
eq("plain", parseCsv("a,b\nc,d"), [["a", "b"], ["c", "d"]]);
eq("a quoted comma", parseCsv('x,"y,z"'), [["x", "y,z"]]);
process.exit(failed > 0 ? 1 : 0);
