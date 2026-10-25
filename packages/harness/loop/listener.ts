// What the loop reports as a turn goes: the agent's text and thinking by message, a tool call as
// it starts, its output as it comes and its end, and what each request used, so the ACP side can
// stream them out.
import { Message, Usage } from "../model/message.ts";
import { CompactionResult } from "./compact.ts";
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
  /** A message joined the conversation: the user's, the assistant's, a batch's results. */
  onMessage: ((m: Message) => void) | null = null;
  /** The context was compacted: the summary stands for the messages before the first kept one. */
  onCompaction: ((c: CompactionResult) => void) | null = null;
}
