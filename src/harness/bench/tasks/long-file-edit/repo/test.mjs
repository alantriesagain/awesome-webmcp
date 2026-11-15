import { gaugeText, progressText, metricLabel, metricIdsFor } from "./src/report.mjs";

let failed = 0;
const eq = (name, got, want) => {
  if (got === want) console.log("ok " + name);
  else { failed++; console.log("FAIL " + name + ": got " + JSON.stringify(got) + ", want " + JSON.stringify(want)); }
};

eq("gauge at the top", gaugeText(150), "100%");
eq("gauge below the bottom", gaugeText(-20), "0%");
eq("gauge rounds to one decimal", gaugeText(42.24), "42.2%");
eq("progress at the top", progressText(150), "100%");
eq("progress rounds", progressText(42.6), "43%");
eq("a label", metricLabel("api_requests"), "API requests");
eq("an owner's metrics", String(metricIdsFor("platform").length > 0), "true");

console.log("done: " + String(failed) + " failed");
process.exit(failed > 0 ? 1 : 0);
