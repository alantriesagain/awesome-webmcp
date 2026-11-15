// The session's skill runs, for a Skills tab: a skill the agent loaded with a call (Claude Code's
// Skill tool, opencode's skill tool: a call of the `skill` category whose summary is the skill's
// name) or one the user typed as a command (a "command" notice whose first word is the skill's
// name with its slash, once the agent has said which skills it has), and how the turn went on from
// there: the calls it made after the skill until the next skill or the turn's end.
import { callState, FAILED, RUNNING, STOPPED, DONE } from "./calls.ts";
import { ChatModel, Item, NOTICE, SKILL, TOOL } from "./model.ts";

/** One run of a skill: the skill, the call that loaded it ("" for one typed), where it stands and how the turn went on. */
export class SkillRun {
  readonly name: string;
  readonly callId: string;
  /** running, done, failed or stopped (calls.ts). */
  state = RUNNING;
  /** When the skill was loaded and when its run ended (ms since the epoch; 0 for not yet). */
  startedMs = 0;
  endedMs = 0;
  /** The calls the turn made after the skill, up to the next skill or the turn's end. */
  calls = 0;

  constructor(name: string, callId: string) {
    this.name = name;
    this.callId = callId;
  }
}

/** The skill a typed command names ("/name args" among `known`), "" for none. */
const typedSkill = (text: string, known: string[]): string => {
  if (!text.startsWith("/")) return "";
  const space = text.search(/\s/);
  const name = (space > 0 ? text.slice(1, space) : text.slice(1)).trim();
  return name.length > 0 && known.includes(name) ? name : "";
};

/** The skill `item` starts a run of ("" when it starts none): a skill call's name, or a typed command's skill. */
const skillOf = (item: Item, known: string[]): string => {
  if (item.kind === TOOL && item.category === SKILL) return item.summary.split(/\s/)[0];
  if (item.kind === NOTICE && item.tone === "command") return typedSkill(item.text, known);
  return "";
};

/** The session's skill runs, oldest first, from each turn's own items (a subagent's are not read). */
export const skillRuns = (model: ChatModel): SkillRun[] => {
  const known = model.skills.map((s) => s.name);
  const out: SkillRun[] = [];
  for (const turn of model.turns) {
    const ended = turn.result !== null;
    const endedAt = ended ? turn.at + (turn.result !== null ? turn.result.durationMs : 0) : 0;
    let run: SkillRun | null = null;
    /** When the latest of the run's calls ended (0: none has). */
    let lastEnd = 0;
    /** The run so far is over: a later skill, or the turn's end. */
    const close = (): void => {
      if (run === null) return;
      if (run.state === RUNNING) {
        run.state = DONE;
        run.endedMs = lastEnd > 0 ? lastEnd : endedAt;
      }
      run = null;
      lastEnd = 0;
    };
    for (const item of turn.body.children) {
      const name = skillOf(item, known);
      if (name.length > 0) {
        close();
        run = new SkillRun(name, item.kind === TOOL ? item.id : "");
        run.startedMs = item.startedAt > 0 ? item.startedAt : turn.at;
        if (item.kind === TOOL) {
          lastEnd = item.endedAt;
          const state = callState(item);
          if (state === FAILED || state === STOPPED) {
            run.state = state;
            run.endedMs = item.endedAt;
          }
        }
        out.push(run);
        continue;
      }
      if (run !== null && item.kind === TOOL) {
        run.calls++;
        if (item.endedAt > lastEnd) lastEnd = item.endedAt;
      }
    }
    // A run in a turn still open goes on; one whose skill call failed or stopped keeps that.
    if (ended) close();
  }
  return out;
};
