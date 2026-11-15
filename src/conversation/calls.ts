// Claude's tool calls, for the Tools tab and the code column: where a call stands, how long it
// took (or has been running; @light/ui/duration.ts `took` writes it), and the call a tool use id names, at any depth.
import { ChatModel, Item, TOOL } from "./model.ts";

export const RUNNING = "running";
export const DONE = "done";
export const FAILED = "failed";
/** It had no result when its turn ended (an interrupt, a resumed session cut short). */
export const STOPPED = "stopped";

/** Where call `item` stands: running, done, failed or stopped. */
export const callState = (item: Item): string => {
  const task = item.task;
  // A background subagent runs on after its call returned; its report decides when it ends.
  if (task !== null) {
    if (task.status === "running") return RUNNING;
    if (task.status === "failed" || task.status === "killed") return FAILED;
    if (task.status.length > 0) return DONE;
  }
  if (item.result !== null) return item.result.isError ? FAILED : DONE;
  return item.endedAt > 0 ? STOPPED : RUNNING;
};

/** How long `item` took, or has taken by `now`; -1 when its start is not known. */
export const callMs = (item: Item, now: number): number => {
  if (item.startedAt <= 0) return -1;
  return Math.max(0, (item.endedAt > 0 ? item.endedAt : now) - item.startedAt);
};

const findIn = (items: Item[], id: string): Item | null => {
  for (const item of items) {
    if (item.kind !== TOOL) continue;
    if (item.id === id) return item;
    const nested = findIn(item.children, id);
    if (nested !== null) return nested;
  }
  return null;
};

/** The call tool use `id` names (a subagent's own calls included), or null. */
export const findCall = (model: ChatModel, id: string): Item | null => {
  for (const t of model.turns) {
    const found = findIn(t.body.children, id);
    if (found !== null) return found;
  }
  return null;
};
