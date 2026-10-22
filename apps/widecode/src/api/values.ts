// What the runtime and its answers (src/api/*.ts) share: reading a call's arguments, writing answers as JSON text.
import { Branch, Commit, CommitFile } from "@light/workspace/git-log.ts";
import { FAILED, HostAnswer, OK } from "@light/plugins/engine.ts";

import { listOf, str, strs } from "@light/lib/json.ts";
export const num = (v: unknown): number => (typeof v === "number" ? v : -1);
export { listOf as list, str, strs };
/** `v` as a count of cells (a positive number, floored), else `fallback`. */
export const cells = (v: unknown, fallback: number): number => (typeof v === "number" && v > 0 ? Math.floor(v) : fallback);
/** A session as an agent's plugin lists it. */
export interface ListedSession {
  id?: unknown;
  title?: unknown;
  firstPrompt?: unknown;
  mtimeMs?: unknown;
  size?: unknown;
  cwd?: unknown;
  lastPrompt?: unknown;
  model?: unknown;
}

export const json = (v: unknown): string => {
  const text = JSON.stringify(v);
  return text === undefined ? "null" : text;
};
export const answer = (v: unknown): HostAnswer => new HostAnswer(OK, json(v));
/** An answer already written as JSON text. */
export const answerText = (text: string): HostAnswer => new HostAnswer(OK, text);
import { listText, objectText } from "@light/lib/json.ts";
export { listText, objectText };
export const refuse = (message: string): HostAnswer => new HostAnswer(FAILED, message);
/** A commit a plugin passed back ({ sha, short, subject, parents }); null when it is not one. */
export const commitOf = (v: unknown): Commit | null => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const f = v as { sha?: unknown; short?: unknown; subject?: unknown; parents?: unknown; timeMs?: unknown; author?: unknown };
  const c = new Commit();
  c.sha = str(f.sha);
  c.short = str(f.short);
  c.subject = str(f.subject);
  c.parents = strs(f.parents);
  c.timeMs = typeof f.timeMs === "number" ? f.timeMs : 0;
  c.author = str(f.author);
  return c.sha.length > 0 ? c : null;
};
export const commitText = (c: Commit): string =>
  objectText(["sha", "short", "parents", "timeMs", "author", "subject"], [json(c.sha), json(c.short), json(c.parents), String(c.timeMs), json(c.author), json(c.subject)]);
export const branchText = (b: Branch): string =>
  objectText(
    ["name", "upstream", "ahead", "behind", "gone", "current", "commitMs", "subject"],
    [json(b.name), json(b.upstream), String(b.ahead), String(b.behind), json(b.gone), json(b.current), String(b.commitMs), json(b.subject)],
  );
export const fileText = (f: CommitFile): string => objectText(["path", "mark", "added", "removed", "binary"], [json(f.path), json(f.mark), String(f.added), String(f.removed), json(f.binary)]);
