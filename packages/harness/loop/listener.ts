// What the loop reports as a turn goes: the agent's text and thinking by message, a tool call as
// it starts, its output as it comes and its end, and what each request used, so the ACP side can
// stream them out.
import { Usage } from "../model/message.ts";
import { ToolOutcome } from "../tools/tool.ts";

export class LoopListener {
  onText: ((messageId: string, delta: string) => void) | null = null;
  onThinking: ((messageId: string, delta: string) => void) | null = null;
  /** A request ended: what it used. */
  onUsage: ((usage: Usage) => void) | null = null;
  /** A call starts: its id, its tool and its input as JSON text. */
  onToolStart: ((callId: string, name: string, inputJson: string) => void) | null = null;
  /** A long call's output so far. */
  onToolOutput: ((callId: string, text: string) => void) | null = null;
  onToolEnd: ((callId: string, outcome: ToolOutcome) => void) | null = null;
}
