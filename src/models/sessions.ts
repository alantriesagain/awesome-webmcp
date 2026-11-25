// The session records lightcode keeps in a project: a light model over `<folder>/.lightcode/sessions.jsonl`,
// one row per session the agent ran there, its id the agent's session id. The fields are what the
// Sessions tab and a resume read back: the title and who gave it, when it was made and last changed,
// its cost and thinking tokens across the agent's processes, the model and effort it ran on, the
// context window the agent last reported, the commit it started on, the file the code column showed, the agent it belongs to.
import T from "@lightstart/light/types";
import { defineModel } from "@lightstart/light/model";
import type { ModelSchema } from "@lightstart/light/model";

const schema: ModelSchema = {
  title: T.string(""),
  titleBy: T.string(""),
  createdMs: T.number(0),
  updatedMs: T.number(0),
  costUsd: T.number(0),
  thinkingTokens: T.number(0),
  model: T.string(""),
  effort: T.string(""),
  contextWindow: T.number(0),
  baseCommit: T.string(""),
  file: T.string(""),
  agent: T.string(""),
};

export const sessions = defineModel("sessions", schema);

export default sessions;
