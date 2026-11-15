// A session loaded again, shown to the client as its turns were: a user message as one chunk,
// the agent's text and thinking as chunks under their message id, each tool call as one
// completed call with the outcome its result kept; paced, since the client's reader batches
// lines and drops past a limit.
import { Message, TEXT, THINKING, TOOL_CALL, TOOL_RESULT } from "../model/message.ts";
import { ToolOutcome } from "../tools/tool.ts";
import { DiffBlock, chunkUpdate, toolCallReplay, userChunkUpdate } from "../acp/updates.ts";

const PACE_LINES = 200;
const PACE_MS = 10;

const wait = (ms: number): Promise<void> => new Promise<void>((settle) => setTimeout(() => settle(), ms));

/** The updates that show `messages` again, in order. */
export const replayUpdates = (sessionId: string, messages: Message[]): string[] => {
  const out: string[] = [];
  const kept = new Map<string, string>();
  for (const m of messages) for (const p of m.parts) if (p.kind === TOOL_RESULT) kept.set(p.callId, p.acpJson);
  for (const m of messages) {
    if (m.role === "user") {
      const text = m.text();
      if (text.length > 0) out.push(userChunkUpdate(sessionId, m.id, text));
      continue;
    }
    for (const p of m.parts) {
      if (p.kind === TEXT && p.text.length > 0) out.push(chunkUpdate(sessionId, "agent_message_chunk", m.id, p.text));
      else if (p.kind === THINKING && p.text.length > 0) out.push(chunkUpdate(sessionId, "agent_thought_chunk", m.id, p.text));
      else if (p.kind === TOOL_CALL) {
        const text = kept.get(p.callId) ?? "";
        const got = text.length > 0 ? ToolOutcome.parse(text) : null;
        const o = got !== null ? got.outcome : ToolOutcome.failed("no result kept");
        const diff = o.diffPath.length > 0 && !o.isError ? new DiffBlock(o.diffPath, o.created, o.oldText, o.newText) : null;
        out.push(toolCallReplay(sessionId, p.callId, got !== null && got.title.length > 0 ? got.title : p.name, got !== null ? got.kind : "other", p.inputJson, o.locations, o.isError, o.text, diff, o.rawOutputJson));
      }
    }
  }
  return out;
};

/** `lines` through `notify`, a pause every PACE_LINES. */
export const replayPaced = async (lines: string[], notify: (paramsText: string) => void): Promise<void> => {
  for (let i = 0; i < lines.length; i++) {
    notify(lines[i]);
    if ((i + 1) % PACE_LINES === 0) await wait(PACE_MS);
  }
};
