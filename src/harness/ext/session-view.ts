// A session's entries as pi's SessionManager shows them: the header, a message entry with its
// AgentMessage (a custom one as `custom_message`), a model change, a compaction, the title as
// `session_info`, a custom entry with its data, and anything else with its own fields.
import { listOf, parseJson, recordOf } from "@lightstart/lib/json.ts";
import { COMPACTION, CUSTOM, Entry, MESSAGE, MODEL, SESSION, TITLE, USAGE } from "../session/entries.ts";
import { messageToAgent, messagesToAgent } from "./messages.ts";

const iso = (at: number): string => new Date(at).toISOString();

const base = (type: string, e: Entry): string[] => [
  '"type":' + JSON.stringify(type),
  '"id":' + JSON.stringify(e.id),
  '"parentId":' + (e.parentId.length > 0 ? JSON.stringify(e.parentId) : "null"),
  '"timestamp":' + JSON.stringify(iso(e.at)),
];

/** The session's header as pi's SessionHeader. */
export const piHeader = (h: Entry): string => "{" + ['"type":"session"', '"version":' + String(h.version), '"id":' + JSON.stringify(h.id), '"timestamp":' + JSON.stringify(iso(h.at)), '"cwd":' + JSON.stringify(h.cwd)].join(",") + "}";

/** One entry as pi's SessionEntry, JSON text. */
export const piEntry = (e: Entry): string => {
  if (e.kind === MESSAGE) {
    const pi = recordOf(messageToAgent(e.message()));
    const content = pi !== null && pi["content"] !== undefined ? JSON.stringify(pi["content"]) : '"\\u0000"';
    if (e.customType.length > 0) {
      const fields = base("custom_message", e);
      fields.push('"customType":' + JSON.stringify(e.customType), '"content":' + content, '"display":' + (e.display ? "true" : "false"));
      if (e.dataJson.length > 0) fields.push('"details":' + e.dataJson);
      return "{" + fields.join(",") + "}";
    }
    const fields = base("message", e);
    fields.push('"message":' + (pi !== null ? JSON.stringify(pi) : "null"));
    return "{" + fields.join(",") + "}";
  }
  if (e.kind === MODEL) {
    const at = e.value.indexOf("/");
    const provider = at >= 0 ? e.value.slice(0, at) : "";
    const modelId = at >= 0 ? e.value.slice(at + 1) : e.value;
    const fields = base("model_change", e);
    fields.push('"provider":' + JSON.stringify(provider), '"modelId":' + JSON.stringify(modelId));
    return "{" + fields.join(",") + "}";
  }
  if (e.kind === COMPACTION) {
    const fields = base("compaction", e);
    fields.push('"summary":' + JSON.stringify(e.summary));
    if (e.firstKeptEntryId.length > 0) fields.push('"firstKeptEntryId":' + JSON.stringify(e.firstKeptEntryId));
    fields.push('"tokensBefore":' + String(e.tokensBefore));
    return "{" + fields.join(",") + "}";
  }
  if (e.kind === TITLE) {
    const fields = base("session_info", e);
    fields.push('"name":' + JSON.stringify(e.value));
    return "{" + fields.join(",") + "}";
  }
  if (e.kind === CUSTOM) {
    const fields = base("custom", e);
    fields.push('"customType":' + JSON.stringify(e.customType));
    if (e.dataJson.length > 0) fields.push('"data":' + e.dataJson);
    return "{" + fields.join(",") + "}";
  }
  // A request's usage is data kept beside the conversation, never the model's: pi's custom entry.
  if (e.kind === USAGE) {
    const fields = base("custom", e);
    fields.push('"customType":"usage"', '"data":' + (e.dataJson.length > 0 ? e.dataJson : "{}"));
    return "{" + fields.join(",") + "}";
  }
  const fields = base(e.kind === SESSION ? "session" : e.kind.length > 0 ? e.kind : "unknown", e);
  if (e.value.length > 0) fields.push('"value":' + JSON.stringify(e.value));
  return "{" + fields.join(",") + "}";
};

/** One entry as pi's SessionEntries, JSON texts: a message holding a batch's tool results is one
 * entry per result (the first keeps the entry's id, the next `<id>:<n>`, each the previous one's
 * child), as pi keeps a tool result a message of its own. */
export const piEntryList = (e: Entry): string[] => {
  if (e.kind !== MESSAGE || e.customType.length > 0) return [piEntry(e)];
  const messages = listOf(parseJson(messagesToAgent([e.message()])));
  if (messages.length <= 1) return [piEntry(e)];
  const out: string[] = [];
  let parent = e.parentId;
  for (let i = 0; i < messages.length; i++) {
    const id = i === 0 ? e.id : e.id + ":" + String(i);
    out.push("{" + ['"type":"message"', '"id":' + JSON.stringify(id), '"parentId":' + (parent.length > 0 ? JSON.stringify(parent) : "null"), '"timestamp":' + JSON.stringify(iso(e.at)), '"message":' + JSON.stringify(messages[i])].join(",") + "}");
    parent = id;
  }
  return out;
};

/** Entries as one JSON array. */
export const piEntries = (entries: Entry[]): string => {
  const out: string[] = [];
  for (const e of entries) for (const text of piEntryList(e)) out.push(text);
  return "[" + out.join(",") + "]";
};

/** The entry of `id` among `entries` as pi's SessionEntry ("null" for none), a batch's later results included. */
export const piEntryById = (entries: Entry[], id: string): string => {
  for (const e of entries)
    if (e.id === id || id.startsWith(e.id + ":"))
      for (const text of piEntryList(e)) {
        const r = recordOf(parseJson(text));
        if (r !== null && r["id"] === id) return text;
      }
  return "null";
};
