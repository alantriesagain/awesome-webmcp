// The Edit tool: an exact string in a file replaced by another, once (the match must be unique)
// or everywhere with `replace_all`; a file the model has not read takes one replacement of text
// found in it exactly once (the exact match shows the model knows that part, however it saw it:
// a `cat` through Bash, a Grep), any other edit of it is refused until it is read; the file's
// line ending (CRLF or LF), its BOM and its trailing newline are kept; the result is the change as
// a patch with the file's line numbers, so the model sees what it did.
import { str } from "@lightstart/lib/json.ts";
import { FileText, changeOutcome, writeText } from "./files.ts";
import { resolvePath } from "./read.ts";
import { ToolContext, ToolOutcome } from "./tool.ts";

/** Where `needle` occurs in `text`, at most `max` positions. */
const positions = (text: string, needle: string, max: number): number[] => {
  const out: number[] = [];
  let at = text.indexOf(needle);
  while (at >= 0 && out.length < max) {
    out.push(at);
    at = text.indexOf(needle, at + needle.length);
  }
  return out;
};

const lineOf = (text: string, at: number): number => text.slice(0, at).split("\n").length;

export const editTool = (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> => {
  const given = str(input["file_path"]);
  const oldString = str(input["old_string"]);
  const newString = str(input["new_string"]);
  const all = input["replace_all"] === true;
  const path = resolvePath(ctx.cwd, given);
  if (oldString.length === 0) return done(ToolOutcome.failed("old_string is empty: use Write for a new file"));
  if (oldString === newString) return done(ToolOutcome.failed("old_string and new_string are the same"));
  const file = FileText.read(path);
  if (file.error.length > 0) return done(ToolOutcome.failed(file.error));
  if (!file.exists) return done(ToolOutcome.failed(given + " does not exist: use Write for a new file"));
  const crlf = file.text.includes("\r\n");
  const from = crlf ? oldString.replace(/\r?\n/g, "\r\n") : oldString;
  const to = crlf ? newString.replace(/\r?\n/g, "\r\n") : newString;
  const found = positions(file.text, from, 3);
  if (found.length === 0) return done(ToolOutcome.failed("old_string not found in " + given + (crlf ? " (the file uses CRLF line endings)" : "")));
  if (found.length > 1 && !ctx.reads.has(path)) return done(ToolOutcome.failed(given + " was not read in this session: read it first, or give an old_string that occurs once in it"));
  if (found.length > 1 && !all) return done(ToolOutcome.failed("old_string occurs " + (found.length >= 3 ? "3 or more" : String(found.length)) + " times in " + given + " (lines " + found.map((at) => String(lineOf(file.text, at))).join(", ") + "): make it unique with more context, or set replace_all"));
  const text = all ? file.text.split(from).join(to) : file.text.slice(0, found[0]) + to + file.text.slice(found[0] + from.length);
  const count = all ? positions(file.text, from, 1000000).length : 1;
  try {
    writeText(path, text, file.mode);
  } catch (e) {
    return done(ToolOutcome.failed("cannot write " + given + ": " + (e instanceof Error ? e.message : "error")));
  }
  const out = changeOutcome(path, given, false, file.text, text);
  out.text = "Edited " + given + " (" + String(count) + (count === 1 ? " replacement)" : " replacements)") + "\n" + out.patch.split("\n").slice(2).join("\n");
  return done(out);
};

const done = (o: ToolOutcome): Promise<ToolOutcome> => new Promise<ToolOutcome>((settle) => settle(o));
