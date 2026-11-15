import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePipeline } from "./pipeline.mjs";

const stages = parsePipeline(readFileSync(fileURLToPath(new URL("../pipeline.pipe", import.meta.url)), "utf8"));
for (const stage of stages) {
  console.log(stage.name);
  for (const step of stage.steps) {
    console.log("  " + step.name);
    for (const sub of step.substeps) console.log("    " + sub);
  }
}
