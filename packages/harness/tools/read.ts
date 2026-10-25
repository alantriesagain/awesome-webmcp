// The Read tool: a file's lines numbered as `cat -n` writes them, from an offset, a limit of lines
// (2000 by default) and of characters per line (2000), 256 KB of the file at most; a binary file
// or a folder is refused; a relative path is under the folder.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { num, str } from "@light/lib/json.ts";
import { ToolContext, ToolOutcome } from "./tool.ts";

const MAX_BYTES = 262144;
const MAX_LINES = 2000;
const MAX_LINE = 2000;

/** `path` under `cwd` unless absolute. */
export const resolvePath = (cwd: string, path: string): string => (isAbsolute(path) ? path : join(cwd, path));

/** Up to `maxBytes` of the file at `path` as text; binary when it holds a NUL byte early; null when it cannot be read. */
export const readCapped = (path: string, maxBytes: number): { text: string; size: number; binary: boolean } | null => {
  let size = 0;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }
  const length = size < maxBytes ? size : maxBytes;
  const buf = Buffer.alloc(length);
  let n = 0;
  try {
    const fd = openSync(path, "r");
    try {
      n = readSync(fd, buf, 0, length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const got = buf.subarray(0, n);
  const probe = got.subarray(0, 8192);
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return { text: "", size, binary: true };
  return { text: got.toString("utf8"), size, binary: false };
};

export const readTool = (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> => {
  const out = new ToolOutcome();
  const given = str(input["file_path"]);
  const path = resolvePath(ctx.cwd, given);
  const got = readCapped(path, MAX_BYTES);
  if (got === null) return done(ToolOutcome.failed("cannot read " + given + ": not a file, or not readable"));
  out.locations.push(path);
  if (got.binary) return done(ToolOutcome.failed(given + " is a binary file"));
  const lines = got.text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1].length === 0 && got.text.endsWith("\n")) lines.pop();
  const offset = Math.max(1, Math.floor(num(input["offset"], 1)));
  const limit = Math.max(1, Math.min(MAX_LINES, Math.floor(num(input["limit"], MAX_LINES))));
  const shown: string[] = [];
  for (let i = offset - 1; i < lines.length && shown.length < limit; i++) {
    const line = lines[i].length > MAX_LINE ? lines[i].slice(0, MAX_LINE) + "…" : lines[i];
    shown.push(String(i + 1).padStart(6, " ") + "\t" + line);
  }
  const notes: string[] = [];
  if (offset - 1 + shown.length < lines.length) notes.push("(" + String(lines.length - (offset - 1 + shown.length)) + " more lines: read from line " + String(offset + shown.length) + ")");
  if (got.size > MAX_BYTES) notes.push("(the file is " + String(got.size) + " bytes; the first " + String(MAX_BYTES) + " were read)");
  out.text = (shown.length > 0 ? shown.join("\n") : "(empty file)") + (notes.length > 0 ? "\n" + notes.join("\n") : "");
  return done(out);
};

const done = (o: ToolOutcome): Promise<ToolOutcome> => new Promise<ToolOutcome>((settle) => settle(o));
