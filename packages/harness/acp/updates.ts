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

export const commandsUpdate = (sessionId: string, commands: string[][]): string =>
  update(sessionId, ["sessionUpdate", "availableCommands"], ['"available_commands_update"', listText(commands.map((c) => objectText(["name", "description"], [JSON.stringify(c[0]), JSON.stringify(c[1])])))]);

export const optionsUpdate = (sessionId: string, optionsText: string): string => update(sessionId, ["sessionUpdate", "configOptions"], ['"config_option_update"', optionsText]);

export const modeUpdate = (sessionId: string, mode: string): string => update(sessionId, ["sessionUpdate", "currentModeId"], ['"current_mode_update"', JSON.stringify(mode)]);

/** A call announced: `status` pending or in_progress, its tool as the title, the kind, its input as JSON text, the files it touches. */
export const toolCallUpdate = (sessionId: string, callId: string, title: string, kind: string, status: string, rawInputJson: string, locations: string[]): string =>
  update(sessionId, ["sessionUpdate", "toolCallId", "title", "kind", "status", "rawInput", "locations"], ['"tool_call"', JSON.stringify(callId), JSON.stringify(title), JSON.stringify(kind), JSON.stringify(status), rawInputJson, listText(locations.map((p) => objectText(["path"], [JSON.stringify(p)])))]);

/** A call's end: `completed` or `failed`, its text, the raw output as JSON text ("" for none). */
export const toolCallEnd = (sessionId: string, callId: string, failed: boolean, text: string, rawOutputJson: string): string => {
  const fields = ["sessionUpdate", "toolCallId", "status", "content"];
  const values = ['"tool_call_update"', JSON.stringify(callId), failed ? '"failed"' : '"completed"', listText([objectText(["type", "content"], ['"content"', objectText(["type", "text"], ['"text"', JSON.stringify(text)])])])];
  if (rawOutputJson.length > 0) {
    fields.push("rawOutput");
    values.push(rawOutputJson);
  }
  return update(sessionId, fields, values);
};
