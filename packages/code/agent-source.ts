// A subagent's steps, for the code column: what it was told, then its items as the chat draws them
// (conversation/render.ts), flat instead of nested, then what it handed back. Built again when the
// conversation changes, so a running subagent's steps arrive as it takes them.
import { palette } from "@light/ui/palette.ts";
import { agentPrompt, agentStatus, findAgent } from "@widecode/conversation/agents.ts";
import { ChatModel } from "@widecode/conversation/model.ts";
import { itemLines, promptLines } from "@widecode/conversation/render.ts";
import { Line, Run } from "@bootstrapp/light/native/tui/lines.ts";
import { wrap } from "@light/ui/text.ts";
import { ConversationHolder, ModelSource } from "@widecode/conversation/model-source.ts";

/** What it handed back, at most this many lines. */
const RESULT_LINES = 40;

export class AgentSource extends ModelSource {
  /** The subagent's call (its tool use id). */
  readonly id: string;

  constructor(holder: ConversationHolder, id: string) {
    super(holder);
    this.id = id;
  }

  protected rebuild(model: ChatModel, width: number): void {
    const out: Line[] = [];
    const note = (text: string): void => {
      const l = new Line();
      l.add(text, palette.dim);
      out.push(l);
    };
    const item = findAgent(model, this.id);
    if (item === null) {
      note("This subagent is not in the conversation any more.");
      this.lines = out;
      return;
    }
    for (const l of promptLines(agentPrompt(item), width)) out.push(l);
    for (const child of item.children) {
      const lines = itemLines(child, this.ctx, [], width);
      if (lines.length === 0) continue;
      out.push(new Line());
      for (const l of lines) out.push(l);
    }
    if (item.children.length === 0) {
      out.push(new Line());
      note(agentStatus(item) === "running" ? "Starting…" : "No steps to show: its transcript was not found.");
    }
    const result = item.result;
    if (result !== null && result.text.trim().length > 0) {
      out.push(new Line());
      note("↳ handed back:");
      const all = result.text.trim().split("\n");
      for (const t of all.slice(0, RESULT_LINES)) for (const l of wrap([new Run(t, result.isError ? palette.bad : "")], width, [new Run("  ", "")], [new Run("  ", "")], "")) out.push(l);
      if (all.length > RESULT_LINES) note("  … " + String(all.length - RESULT_LINES) + " more lines");
    }
    this.lines = out;
  }
}
