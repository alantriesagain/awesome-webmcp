// The `session/update` notifications the daemon sends, as JSON text: a message's or a thought's
// chunk (one message id per block, so the client joins its chunks), the usage after a request, the
// commands the session answers, the config options and the mode as they change.
import { listText, objectText } from "@light/lib/json.ts";

const update = (sessionId: string, fields: string[], values: string[]): string => objectText(["sessionId", "update"], [JSON.stringify(sessionId), objectText(fields, values)]);

/** `kind` is "agent_message_chunk" or "agent_thought_chunk". */
export const chunkUpdate = (sessionId: string, kind: string, messageId: string, text: string): string =>
  update(sessionId, ["sessionUpdate", "messageId", "content"], [JSON.stringify(kind), JSON.stringify(messageId), objectText(["type", "text"], ['"text"', JSON.stringify(text)])]);

/** What the context holds (`used`) of `size`, and the session's cost in dollars (below 0: unknown). */
export const usageUpdate = (sessionId: string, used: number, size: number, costUsd: number): string => {
  const fields = ["sessionUpdate", "used", "size"];
  const values = ['"usage_update"', String(used), String(size)];
  if (costUsd >= 0) {
    fields.push("cost");
    values.push(objectText(["amount", "currency"], [String(costUsd), '"USD"']));
  }
  return update(sessionId, fields, values);
};

/** The session's name as it changed. */
export const sessionInfoUpdate = (sessionId: string, name: string): string => update(sessionId, ["sessionUpdate", "name"], ['"session_info_update"', JSON.stringify(name)]);

export const commandsUpdate = (sessionId: string, commands: string[][]): string =>
  update(sessionId, ["sessionUpdate", "availableCommands"], ['"available_commands_update"', listText(commands.map((c) => {
    const fields = ["name", "description"];
    const values = [JSON.stringify(c[0]), JSON.stringify(c[1])];
    if (c.length > 2 && c[2].length > 0) {
      fields.push("input");
      values.push(objectText(["type", "hint"], ['"text"', JSON.stringify(c[2])]));
    }
    return objectText(fields, values);
  }))]);

export const optionsUpdate = (sessionId: string, optionsText: string): string => update(sessionId, ["sessionUpdate", "configOptions"], ['"config_option_update"', optionsText]);

export const modeUpdate = (sessionId: string, mode: string): string => update(sessionId, ["sessionUpdate", "currentModeId"], ['"current_mode_update"', JSON.stringify(mode)]);

/** A call announced: `status` pending or in_progress, its tool as the title, the kind, its input as JSON text, the files it touches. */
export const toolCallUpdate = (sessionId: string, callId: string, title: string, kind: string, status: string, rawInputJson: string, locations: string[]): string =>
  update(sessionId, ["sessionUpdate", "toolCallId", "title", "kind", "status", "rawInput", "locations"], ['"tool_call"', JSON.stringify(callId), JSON.stringify(title), JSON.stringify(kind), JSON.stringify(status), rawInputJson, listText(locations.map((p) => objectText(["path"], [JSON.stringify(p)])))]);

/** A change a call made, for the chat: the file, its text before (none for a new file) and after. */
export class DiffBlock {
  readonly path: string;
  readonly created: boolean;
  readonly oldText: string;
  readonly newText: string;

  constructor(path: string, created: boolean, oldText: string, newText: string) {
    this.path = path;
    this.created = created;
    this.oldText = oldText;
    this.newText = newText;
  }
}

/** A call's end: `completed` or `failed`, its text, a change as a diff block, the raw output as JSON text ("" for none). */
export const toolCallEnd = (sessionId: string, callId: string, failed: boolean, text: string, diff: DiffBlock | null, rawOutputJson: string): string => {
  const fields = ["sessionUpdate", "toolCallId", "status", "content"];
  const blocks = [objectText(["type", "content"], ['"content"', objectText(["type", "text"], ['"text"', JSON.stringify(text)])])];
  if (diff !== null) blocks.push(objectText(["type", "path", "oldText", "newText"], ['"diff"', JSON.stringify(diff.path), diff.created ? "null" : JSON.stringify(diff.oldText), JSON.stringify(diff.newText)]));
  const values = ['"tool_call_update"', JSON.stringify(callId), failed ? '"failed"' : '"completed"', listText(blocks)];
  if (rawOutputJson.length > 0) {
    fields.push("rawOutput");
    values.push(rawOutputJson);
  }
  return update(sessionId, fields, values);
};

/** A user message shown again by a load: one chunk per message, the id telling messages apart. */
export const userChunkUpdate = (sessionId: string, messageId: string, text: string): string =>
  update(sessionId, ["sessionUpdate", "messageId", "content"], ['"user_message_chunk"', JSON.stringify(messageId), objectText(["type", "text"], ['"text"', JSON.stringify(text)])]);

/** A call shown again by a load: one update with its status, input, files, text, change and raw output. */
export const toolCallReplay = (sessionId: string, callId: string, title: string, kind: string, rawInputJson: string, locations: string[], failed: boolean, text: string, diff: DiffBlock | null, rawOutputJson: string): string => {
  const fields = ["sessionUpdate", "toolCallId", "title", "kind", "status", "rawInput", "locations", "content"];
  const blocks = [objectText(["type", "content"], ['"content"', objectText(["type", "text"], ['"text"', JSON.stringify(text)])])];
  if (diff !== null) blocks.push(objectText(["type", "path", "oldText", "newText"], ['"diff"', JSON.stringify(diff.path), diff.created ? "null" : JSON.stringify(diff.oldText), JSON.stringify(diff.newText)]));
  const values = ['"tool_call"', JSON.stringify(callId), JSON.stringify(title), JSON.stringify(kind), failed ? '"failed"' : '"completed"', rawInputJson.length > 0 ? rawInputJson : "{}", listText(locations.map((l) => objectText(["path"], [JSON.stringify(l)]))), listText(blocks)];
  if (rawOutputJson.length > 0) {
    fields.push("rawOutput");
    values.push(rawOutputJson);
  }
  return update(sessionId, fields, values);
};
