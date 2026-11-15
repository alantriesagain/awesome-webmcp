// The conversation in the agent's message shape and back, following pi's AgentMessage: a user
// message holds text and images, an assistant one text, thinking with its signature and tool calls,
// and every tool result is a message of its own. The `context` event gets this text; a replacement is converted back to the
// harness's Message/Part and sent in that one request, never written to the session file.
import { listOf, objectText, parseJson, recordOf, str } from "@light/lib/json.ts";
import { IMAGE, Message, Part, TEXT, THINKING, TOOL_CALL, TOOL_RESULT } from "../model/message.ts";
import { ToolOutcome } from "../tools/tool.ts";

const json = (value: unknown): string => JSON.stringify(value);

const textContent = (text: string): string => objectText(["type", "text"], [json("text"), json(text)]);

const imageContent = (data: string, mimeType: string): string => objectText(["type", "image", "data", "mimeType"], [json("image"), json(data), json(mimeType)]);

/** The conversation in the agent's message shape, JSON text. */
export const messagesToAgent = (messages: Message[]): string => {
  const names = new Map<string, string>();
  for (const m of messages)
    for (const p of m.parts) if (p.kind === TOOL_CALL && p.callId.length > 0) names.set(p.callId, p.name);
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const content: string[] = [];
      for (const p of m.parts) {
        if (p.kind === TEXT) content.push(textContent(p.text));
        else if (p.kind === THINKING) {
          const fields = ['"type":"thinking"', '"thinking":' + json(p.text)];
          if (p.signature.length > 0) fields.push('"thinkingSignature":' + json(p.signature));
          content.push("{" + fields.join(",") + "}");
        } else if (p.kind === TOOL_CALL) content.push(objectText(["type", "id", "name", "arguments"], [json("toolCall"), json(p.callId), json(p.name), p.inputJson.length > 0 ? p.inputJson : "{}"]));
      }
      out.push(objectText(["role", "content"], [json("assistant"), "[" + content.join(",") + "]"]));
      continue;
    }
    const content: string[] = [];
    const results: string[] = [];
    for (const p of m.parts) {
      if (p.kind === TEXT) content.push(textContent(p.text));
      else if (p.kind === IMAGE) content.push(imageContent(p.data, p.mediaType));
      else if (p.kind === TOOL_RESULT) {
        const name = names.get(p.callId) ?? p.name;
        const inner = p.data.length > 0 ? imageContent(p.data, p.mediaType) : textContent(p.text);
        const fields = ["role", "toolCallId", "toolName", "content", "isError"];
        const values = [json("toolResult"), json(p.callId), json(name), "[" + inner + "]", p.isError ? "true" : "false"];
        // A plugin tool's details, kept in the outcome the session file holds.
        const kept = p.acpJson.includes('"detailsJson":"') && !p.acpJson.includes('"detailsJson":""') ? ToolOutcome.parse(p.acpJson) : null;
        if (kept !== null && kept.outcome.detailsJson.length > 0) {
          fields.push("details");
          values.push(kept.outcome.detailsJson);
        }
        results.push(objectText(fields, values));
      }
    }
    if (content.length > 0) out.push(objectText(["role", "content"], [json("user"), "[" + content.join(",") + "]"]));
    for (const r of results) out.push(r);
  }
  return "[" + out.join(",") + "]";
};

/** One message in the agent's shape, null when it has none. */
export const messageToAgent = (m: Message): unknown => {
  const list = listOf(parseJson(messagesToAgent([m])));
  return list.length > 0 ? list[0] : null;
};

const partsOfContent = (content: unknown): Part[] => {
  const parts: Part[] = [];
  if (typeof content === "string") {
    const p = new Part(TEXT);
    p.text = content;
    parts.push(p);
    return parts;
  }
  for (const v of listOf(content)) {
    const r = recordOf(v);
    if (r === null) continue;
    const type = str(r["type"]);
    if (type === "text") {
      const p = new Part(TEXT);
      p.text = str(r["text"]);
      parts.push(p);
    } else if (type === "image") {
      const p = new Part(IMAGE);
      p.mediaType = str(r["mimeType"]);
      p.data = str(r["data"]);
      parts.push(p);
    }
  }
  return parts;
};

/** The agent's messages back as the harness's, null for a value that is not a list of messages. */
export const messagesFromAgent = (value: unknown): Message[] | null => {
  if (!Array.isArray(value)) return null;
  const out: Message[] = [];
  const list = value as unknown[];
  for (let i = 0; i < list.length; i++) {
    const r = recordOf(list[i]);
    if (r === null) continue;
    const role = str(r["role"]);
    const id = "ext" + String(i);
    if (role === "assistant") {
      const m = new Message("assistant", id);
      for (const v of listOf(r["content"])) {
        const c = recordOf(v);
        if (c === null) continue;
        const type = str(c["type"]);
        if (type === "text") {
          const p = new Part(TEXT);
          p.text = str(c["text"]);
          m.parts.push(p);
        } else if (type === "thinking") {
          const p = new Part(THINKING);
          p.text = str(c["thinking"]);
          p.signature = str(c["thinkingSignature"]);
          m.parts.push(p);
        } else if (type === "toolCall") {
          const p = new Part(TOOL_CALL);
          p.callId = str(c["id"]);
          p.name = str(c["name"]);
          p.inputJson = c["arguments"] === undefined ? "{}" : JSON.stringify(c["arguments"]);
          m.parts.push(p);
        }
      }
      out.push(m);
    } else if (role === "toolResult") {
      const m = new Message("user", id);
      const p = new Part(TOOL_RESULT);
      p.callId = str(r["toolCallId"]);
      p.name = str(r["toolName"]);
      p.isError = r["isError"] === true;
      for (const part of partsOfContent(r["content"])) {
        if (part.kind === TEXT) p.text += (p.text.length > 0 ? "\n" : "") + part.text;
        else if (part.kind === IMAGE) {
          p.mediaType = part.mediaType;
          p.data = part.data;
        }
      }
      m.parts.push(p);
      out.push(m);
    } else if (role === "user") {
      const m = new Message("user", id);
      for (const p of partsOfContent(r["content"])) m.parts.push(p);
      out.push(m);
    }
  }
  return out;
};

