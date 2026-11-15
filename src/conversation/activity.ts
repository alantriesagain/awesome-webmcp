// What Claude is doing now, in a few words: the running tool and its summary (a subagent's tool
// inside it), "thinking", "writing", "compacting", or "" between turns; and the step it is on (the
// running call or the thinking), whose start its clock counts from.
import { ChatModel, Item, TEXT, THINKING, TOOL } from "./model.ts";
import { RenderContext, toolSummary } from "./render.ts";

const NO_FOLDER = new RenderContext();

/** What Claude is doing now: the running tool and its summary, or "". */
export const activityOf = (m: ChatModel): string => {
  if (m.status === "compacting") return "compacting";
  const turn = m.current;
  if (turn === null || !m.running) return "";
  const items = turn.body.children;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === TOOL && item.result === null) {
      const nested = item.children.length > 0 ? item.children[item.children.length - 1] : null;
      if (nested !== null && nested.kind === TOOL && nested.result === null) return item.name + " › " + nested.name + " " + toolSummary(nested, NO_FOLDER);
      return item.name + " " + toolSummary(item, NO_FOLDER);
    }
    if (item.kind === THINKING && !item.done) return "thinking";
    if (item.kind === TEXT && !item.done) return "writing";
  }
  return "working";
};

/** The step Claude is on: the running call (a subagent's inside it) or the thinking; null for none. */
export const stepOf = (m: ChatModel): Item | null => {
  const turn = m.current;
  if (turn === null || !m.running) return null;
  const items = turn.body.children;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === TOOL && item.result === null) {
      const nested = item.children.length > 0 ? item.children[item.children.length - 1] : null;
      return nested !== null && nested.kind === TOOL && nested.result === null ? nested : item;
    }
    if (item.kind === THINKING && !item.done) return item;
    if (item.kind === TEXT && !item.done) return null;
  }
  return null;
};
