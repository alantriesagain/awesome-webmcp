// A session's file is lines of entries in pi's shape: each with an `id` and the `parentId` it
// follows (the branch is the walk back from the last one), the time it was written, and its kind:
// `session` (the first line: the folder, when it started), `message` (a role and its parts),
// `model` and `mode` (a change), `title`, `compaction` (a summary standing for what came before
// `firstKeptEntryId`), `custom` (an extension's state, outside the context). A message may be a
// `custom_message` when `customType` is set. One flat class, told apart by `kind`; a line is
// parsed as it is applied.
import { listOf, num, parseJson, recordOf, str } from "@light/lib/json.ts";
import { Message, Part, partJson, partOf } from "../model/message.ts";

export const SESSION = "session";
export const MESSAGE = "message";
export const MODEL = "model";
export const MODE = "mode";
export const TITLE = "title";
export const COMPACTION = "compaction";
export const CUSTOM = "custom";

export class Entry {
  readonly kind: string;
  id = "";
  parentId = "";
  at = 0;
  /** `session`: the folder and the format's version. */
  cwd = "";
  version = 1;
  /** `message`: the role and the parts. */
  role = "";
  parts: Part[] = [];
  /** `model`, `mode`, `title`: the value. */
  value = "";
  /** `compaction`: the summary, the first entry kept after it, the context's size before. */
  summary = "";
  firstKeptEntryId = "";
  tokensBefore = 0;
  /** `custom`: its type and data as JSON text; a message's custom type, display and details. */
  customType = "";
  dataJson = "";
  display = true;

  constructor(kind: string) {
    this.kind = kind;
  }

  /** The entry as one line of the file. */
  line(): string {
    const fields: string[] = ['"kind":' + JSON.stringify(this.kind), '"id":' + JSON.stringify(this.id), '"parentId":' + JSON.stringify(this.parentId), '"at":' + String(this.at)];
    if (this.kind === SESSION) fields.push('"cwd":' + JSON.stringify(this.cwd), '"version":' + String(this.version));
    else if (this.kind === MESSAGE) {
      fields.push('"role":' + JSON.stringify(this.role), '"parts":[' + this.parts.map(partJson).join(",") + "]");
      if (this.customType.length > 0) {
        fields.push('"customType":' + JSON.stringify(this.customType), '"display":' + (this.display ? "true" : "false"));
        if (this.dataJson.length > 0) fields.push('"details":' + this.dataJson);
      }
    } else if (this.kind === COMPACTION) fields.push('"summary":' + JSON.stringify(this.summary), '"firstKeptEntryId":' + JSON.stringify(this.firstKeptEntryId), '"tokensBefore":' + String(this.tokensBefore));
    else if (this.kind === CUSTOM) {
      fields.push('"customType":' + JSON.stringify(this.customType));
      if (this.dataJson.length > 0) fields.push('"data":' + this.dataJson);
    } else fields.push('"value":' + JSON.stringify(this.value));
    return "{" + fields.join(",") + "}";
  }

  /** The entry a line holds, null for a line that is not one. */
  static parse(line: string): Entry | null {
    const r = recordOf(parseJson(line));
    if (r === null || str(r["kind"]).length === 0) return null;
    const e = new Entry(str(r["kind"]));
    e.id = str(r["id"]);
    e.parentId = str(r["parentId"]);
    e.at = num(r["at"], 0);
    e.cwd = str(r["cwd"]);
    e.version = num(r["version"], 1);
    e.role = str(r["role"]);
    for (const v of listOf(r["parts"])) {
      const p = partOf(v);
      if (p !== null) e.parts.push(p);
    }
    e.value = str(r["value"]);
    e.summary = str(r["summary"]);
    e.firstKeptEntryId = str(r["firstKeptEntryId"]);
    e.tokensBefore = num(r["tokensBefore"], 0);
    e.customType = str(r["customType"]);
    e.display = r["display"] !== false;
    e.dataJson = r["data"] !== undefined ? JSON.stringify(r["data"]) : r["details"] !== undefined ? JSON.stringify(r["details"]) : "";
    return e;
  }

  /** A message entry's message. */
  message(): Message {
    const m = new Message(this.role, this.id);
    for (const p of this.parts) m.parts.push(p);
    m.customType = this.customType;
    m.display = this.display;
    m.detailsJson = this.dataJson;
    return m;
  }

  static ofMessage(m: Message, at: number): Entry {
    const e = new Entry(MESSAGE);
    e.id = m.id;
    e.at = at;
    e.role = m.role;
    e.parts = m.parts.slice();
    e.customType = m.customType;
    e.display = m.display;
    e.dataJson = m.detailsJson;
    return e;
  }

  static ofCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, at: number): Entry {
    const e = new Entry(COMPACTION);
    e.at = at;
    e.summary = summary;
    e.firstKeptEntryId = firstKeptEntryId;
    e.tokensBefore = tokensBefore;
    return e;
  }

  static ofCustom(customType: string, dataJson: string, at: number): Entry {
    const e = new Entry(CUSTOM);
    e.at = at;
    e.customType = customType;
    e.dataJson = dataJson;
    return e;
  }

  static ofValue(kind: string, id: string, value: string, at: number): Entry {
    const e = new Entry(kind);
    e.id = id;
    e.at = at;
    e.value = value;
    return e;
  }
}
