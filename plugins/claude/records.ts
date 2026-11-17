// Claude Code's transcript records and the folder's sessions: the record readers every other file
// works from (Rec, rec, str, num, list, parse), a transcript's active branch, and the session
// listing (its first prompt, its title from Claude Code's own records).

export type Ev = widecode.ConversationEvent;

/** Any record or nested object, every field `unknown`. */
export interface Rec {
  [key: string]: unknown;
}

export const rec = (v: unknown): Rec | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null);
export const { str, num, list } = widecode.util;

export const { parse } = widecode.util;

// A transcript's active branch: from the leaf (the last message record) back through each record's
// parent (`parentUuid`, a compact boundary's `logicalParentUuid`); records off it were rewound.
// Over a window the walk may stop at a parent the window does not hold.

const CHAINED = ["user", "assistant", "system", "attachment"];

/** The active branch's records, parsed, oldest first. */
export const activeChain = (lines: string[]): Rec[] => {
  const byUuid = new Map<string, { parent: string; r: Rec }>();
  let leaf = "";
  for (const line of lines) {
    const r = rec(parse(line));
    if (r === null) continue;
    const uuid = str(r.uuid);
    if (uuid.length === 0) continue;
    byUuid.set(uuid, { parent: str(r.parentUuid) || str(r.logicalParentUuid), r });
    if (CHAINED.includes(str(r.type)) && r.isSidechain !== true) leaf = uuid;
  }
  const seen = new Set<string>();
  const reversed: Rec[] = [];
  let at = byUuid.get(leaf);
  let uuid = leaf;
  while (at !== undefined && !seen.has(uuid)) {
    seen.add(uuid);
    reversed.push(at.r);
    uuid = at.parent;
    at = uuid.length > 0 ? byUuid.get(uuid) : undefined;
  }
  return reversed.reverse();
};

// The folder's sessions: `<projects>/<folder, every non-alphanumeric as '-'>/<id>.jsonl`, a head
// read for the first prompt and the folder it ran in, a tail for Claude Code's title; cached by
// size and time. Subagents are `<id>/subagents/agent-*.jsonl` with a `.meta.json` each.

const HEAD_BYTES = 64 * 1024;
const TAIL_STEPS = [64 * 1024, 256 * 1024, 1024 * 1024];
const TEXT_MAX = 300;
const NOT_PROMPTS = ["<command-name>", "<command-message>", "<local-command", "<system-reminder>", "Caveat:"];
const TITLE_PREFIXES = ['{"type":"custom-title"', '{"type":"ai-title"', '{"type":"agent-name"', '{"type":"last-prompt"', '{"type":"summary"'];

export const safeId = (id: string): boolean => /^[A-Za-z0-9_-]{1,100}$/.test(id);
const clipText = (text: string): string => {
  const t = text.trim();
  return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) + "…" : t;
};

/** The user's own words in a message's content, "" for an echo of a command or a caveat. */
const promptText = (content: unknown): string => {
  let text = "";
  if (typeof content === "string") text = content;
  else
    for (const b of list(content)) {
      const block = rec(b);
      if (block !== null && block.type === "text" && typeof block.text === "string") text += (text.length > 0 ? " " : "") + block.text;
    }
  const t = text.trim();
  for (const p of NOT_PROMPTS) if (t.startsWith(p)) return "";
  return t;
};

export interface Listed {
  id: string;
  title: string;
  firstPrompt: string;
  lastPrompt: string;
  cwd: string;
  model: string;
  mtimeMs: number;
  size: number;
}

export const summarize = (api: widecode.Api, path: string, id: string, size: number, mtimeMs: number): Listed => {
  const s: Listed = { id, title: "", firstPrompt: "", lastPrompt: "", cwd: "", model: "", mtimeMs, size };
  const head = api.fs.read(path, 0, Math.min(size, HEAD_BYTES)).split("\n");
  if (size > HEAD_BYTES) head.pop();
  for (const line of head) {
    if (line.length === 0 || line.startsWith('{"type":')) continue;
    const r = rec(parse(line));
    if (r === null) continue;
    if (s.cwd.length === 0 && typeof r.cwd === "string") s.cwd = r.cwd;
    if (r.type !== "user" || r.isMeta === true || r.isCompactSummary === true) continue;
    const text = promptText(rec(r.message)?.content);
    if (text.length === 0) continue;
    s.firstPrompt = clipText(text);
    break;
  }
  let custom = "";
  let ai = "";
  let summary = "";
  for (const step of TAIL_STEPS) {
    const length = Math.min(size, step);
    const lines = api.fs.read(path, size - length, length).split("\n");
    if (length < size) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (s.model.length === 0 && lines[i].includes('"type":"assistant"')) {
        const m = rec(rec(parse(lines[i]))?.message)?.model;
        if (typeof m === "string") s.model = m;
      }
      if (!TITLE_PREFIXES.some((p) => lines[i].startsWith(p))) continue;
      const r = rec(parse(lines[i]));
      if (r === null) continue;
      if (custom.length === 0 && typeof r.customTitle === "string") custom = r.customTitle;
      if (ai.length === 0 && typeof r.aiTitle === "string") ai = r.aiTitle;
      if (summary.length === 0 && typeof r.summary === "string") summary = r.summary;
      if (s.lastPrompt.length === 0 && typeof r.lastPrompt === "string") s.lastPrompt = clipText(r.lastPrompt);
    }
    if (custom.length > 0 || ai.length > 0 || length === size) break;
  }
  s.title = clipText(custom.length > 0 ? custom : ai.length > 0 ? ai : summary);
  return s;
};
