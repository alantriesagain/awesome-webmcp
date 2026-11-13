/** The stages of a pipeline file: a stage's steps, a step's substeps, from the leading tabs. */
export const parsePipeline = (text) => {
  const stages = [];
  let stage = null;
  let step = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const depth = line.length - line.replace(/^\t*/, "").length;
    const name = line.slice(depth);
    if (depth === 0) {
      stage = { name, steps: [] };
      stages.push(stage);
      step = null;
    } else if (depth === 1 && stage !== null) {
      step = { name, substeps: [] };
      stage.steps.push(step);
    } else if (depth === 2 && step !== null) {
      step.substeps.push(name);
    } else {
      throw new Error("bad indentation: " + JSON.stringify(line));
    }
  }
  return stages;
};
