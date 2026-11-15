// The session's subagents: its calls of the agent kind (nested ones too), newest last, with where
// each stands. Live, the agent's task reports tell (running, completed, failed); in a resumed
// session there may be none, so the call's result tells: a result is done (an error failed), a
// call closed without one was interrupted.
import { AGENT, ChatModel, Item, TOOL } from "./model.ts";
import { callState, FAILED, RUNNING, STOPPED } from "./calls.ts";

/** Whether `item` is a subagent's call. */
const isAgent = (item: Item): boolean => item.kind === TOOL && item.category === AGENT;

/** Every subagent call in the conversation, in order, nested ones after the call that holds them. */
export const agentsOf = (model: ChatModel): Item[] => {
  const out: Item[] = [];
  const walk = (items: Item[]): void => {
    for (const item of items) {
      if (isAgent(item)) out.push(item);
      if (item.children.length > 0) walk(item.children);
    }
  };
  for (const t of model.turns) walk(t.body.children);
  return out;
};

/** The subagent call with tool use id `id`; null when the conversation holds none. */
export const findAgent = (model: ChatModel, id: string): Item | null => {
  for (const item of agentsOf(model)) if (item.id === id) return item;
  return null;
};

/** "running", "done", "failed" or "interrupted". */
export const agentStatus = (item: Item): string => {
  const state = callState(item);
  if (state === RUNNING) return "running";
  if (state === FAILED) return "failed";
  if (state === STOPPED) return "interrupted";
  return "done";
};

/** Its kind and what it was asked to do. */
export const agentType = (item: Item): string => item.agentType;

export const agentDescription = (item: Item): string => item.agentTask;

/** What it was told (its prompt). */
export const agentPrompt = (item: Item): string => item.agentPrompt;
