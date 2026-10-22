// What must hold of a conversation whatever the agent said, for the tests that check it: idle means
// no open turn and running means one; a closed turn has no call still running (but a background
// subagent's); and drawn at each width, a line is one row of the screen (no line break in it, no
// wider than the width).
import { callState, RUNNING } from "@widecode/conversation/calls.ts";
import { ChatModel, Item, TOOL, Turn } from "@widecode/conversation/model.ts";
import { RenderContext, turnLines } from "@widecode/conversation/render.ts";
import { stringWidth } from "@bootstrapp/light/native/tui/width.ts";

/** The calls under `items` still running, by name, at any depth. */
const running = (items: Item[], out: string[]): void => {
  for (const item of items) {
    if (item.kind !== TOOL) continue;
    const background = item.task !== null && item.task.background;
    if (!background && callState(item) === RUNNING) out.push(item.name);
    running(item.children, out);
  }
};

/** What breaks the invariants in `model` drawn with `ctx` at `widths`; none when it holds. */
export const chatProblems = (model: ChatModel, ctx: RenderContext, widths: number[]): string[] => {
  const out: string[] = [];
  if (!model.running && model.current !== null) out.push("idle with an open turn");
  if (model.running && model.current === null) out.push("running with no open turn");
  for (let i = 0; i < model.turns.length; i++) {
    const t: Turn = model.turns[i];
    if (t === model.current) continue;
    const calls: string[] = [];
    running(t.body.children, calls);
    if (calls.length > 0) out.push("turn " + String(i) + " closed with " + calls.join(", ") + " running");
  }
  for (const width of widths)
    for (let i = 0; i < model.turns.length; i++)
      for (const line of turnLines(model.turns[i], ctx, width)) {
        let text = "";
        for (const r of line.runs) text += r.text;
        if (text.includes("\n")) out.push("turn " + String(i) + " at " + String(width) + ": a line break in a line");
        else if (stringWidth(text) > width) out.push("turn " + String(i) + " at " + String(width) + ": a line of " + String(stringWidth(text)) + " cells");
      }
  return out;
};
