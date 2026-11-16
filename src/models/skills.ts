// The skill runs widecode keeps in a project: a light model over `<folder>/.widecode/skills.jsonl`,
// one row per run of a skill in a session there, kept once the run ended, so the Skills tab can say
// how often each skill ran across sessions. Its id is the session's and the run's (the call that
// loaded the skill, or the time a typed one started), so a session shown again writes over its own
// rows. The fields: the session and agent, the skill, whether the user typed it or the agent chose
// it, how it ended, when it started and ended, the calls the turn made after it.
import T from "@lightstart/light/types";
import { defineModel } from "@lightstart/light/model";
import type { ModelSchema } from "@lightstart/light/model";

const schema: ModelSchema = {
  session: T.string(""),
  agent: T.string(""),
  skill: T.string(""),
  typed: T.boolean(false),
  state: T.string(""),
  startedMs: T.number(0),
  endedMs: T.number(0),
  calls: T.number(0),
};

export const skills = defineModel("skills", schema);

export default skills;
