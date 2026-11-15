// The Write tool: a file written whole (its parents made), the change shown as a diff from what
// was there; a file the model has not read first is refused when it exists, so a write never
// clobbers unseen content.
import { str } from "@light/lib/json.ts";
import { FileText, changeOutcome, writeText } from "./files.ts";
import { resolvePath } from "./read.ts";
import { ToolContext, ToolOutcome } from "./tool.ts";

export const writeTool = (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> => {
  const given = str(input["file_path"]);
  const content = str(input["content"]);
  const path = resolvePath(ctx.cwd, given);
  const file = FileText.read(path);
  if (file.error.length > 0) return done(ToolOutcome.failed(file.error));
  if (file.exists && !ctx.reads.has(path)) return done(ToolOutcome.failed(given + " exists and was not read in this session: read it first, then write or edit it"));
  try {
    writeText(path, content, file.exists ? file.mode : 0o644);
  } catch (e) {
    return done(ToolOutcome.failed("cannot write " + given + ": " + (e instanceof Error ? e.message : "error")));
  }
  ctx.reads.add(path);
  const out = changeOutcome(path, given, !file.exists, file.text, content);
  const lines = content.length === 0 ? 0 : content.replace(/\n$/, "").split("\n").length;
  out.text = (file.exists ? "Wrote " : "Created ") + given + " (" + String(lines) + (lines === 1 ? " line)" : " lines)");
  return done(out);
};

const done = (o: ToolOutcome): Promise<ToolOutcome> => new Promise<ToolOutcome>((settle) => settle(o));
