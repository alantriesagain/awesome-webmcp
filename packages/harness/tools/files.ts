// What Write and Edit share: a file's text whole (4 MB at most, binary refused), written in place
// atomically with its mode kept, its line ending and trailing newline noted, and the outcome's
// change (the diff block for the chat, the unified patch for the code column).
import { chmodSync, existsSync, mkdirSync, statSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { writeAtomic } from "@light/lib/fs.ts";
import { objectText } from "@light/lib/json.ts";
import { counts, hunksOf, unifiedPatch } from "./patch.ts";
import { readCapped } from "./read.ts";
import { ToolOutcome } from "./tool.ts";

export const WHOLE_MAX = 4 * 1024 * 1024;

/** The text of the file at `path` for an edit, with its mode; `exists` false for a new file; an error message when it cannot be edited. */
export class FileText {
  text = "";
  exists = false;
  mode = 0o644;
  error = "";

  static read(path: string): FileText {
    const f = new FileText();
    if (!existsSync(path)) return f;
    let st: Stats | null = null;
    try {
      st = statSync(path);
    } catch {
      st = null;
    }
    if (st === null) {
      f.error = "cannot read " + path;
      return f;
    }
    if (!st.isFile()) {
      f.error = path + " is not a file";
      return f;
    }
    f.exists = true;
    f.mode = st.mode & 0o777;
    if (st.size > WHOLE_MAX) {
      f.error = path + " is larger than " + String(WHOLE_MAX) + " bytes";
      return f;
    }
    const got = readCapped(path, WHOLE_MAX);
    if (got === null) {
      f.error = "cannot read " + path;
      return f;
    }
    if (got.binary) {
      f.error = path + " is a binary file";
      return f;
    }
    f.text = got.text;
    return f;
  }
}

/** Write `text` to `path` atomically, the parents made, the mode kept (`mode` for a new file). */
export const writeText = (path: string, text: string, mode: number): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, text);
  try {
    chmodSync(path, mode);
  } catch {
    // The mode could not be set: the file is written.
  }
};

/** The outcome of a change to `path` from `oldText` (a new file when `created`) to `newText`: the texts, the patch, the raw output with the patch and the counts. */
export const changeOutcome = (path: string, shown: string, created: boolean, oldText: string, newText: string): ToolOutcome => {
  const out = new ToolOutcome();
  const hunks = hunksOf(created ? "" : oldText, newText);
  const n = counts(hunks);
  out.diffPath = path;
  out.created = created;
  out.oldText = oldText;
  out.newText = newText;
  out.patch = unifiedPatch(shown, hunks);
  out.locations.push(path);
  out.rawOutputJson = objectText(["metadata"], [objectText(["filediff"], [objectText(["file", "patch", "additions", "deletions"], [JSON.stringify(path), JSON.stringify(out.patch), String(n.added), String(n.removed)])])]);
  return out;
};
