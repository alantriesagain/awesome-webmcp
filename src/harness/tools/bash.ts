// The Bash tool: a command run in the folder, its output as the result with the exit code when it
// is not 0, a timeout of 120 s by default and 600 s at most, 30 KB of output kept.
import { objectText } from "@lightstart/lib/json.ts";
import { num, str } from "@lightstart/lib/json.ts";
import { Abort } from "../loop/abort.ts";
import { CappedText, runBash } from "./proc.ts";
import { ToolContext, ToolOutcome } from "./tool.ts";

const DEFAULT_MS = 120000;
const MAX_MS = 600000;
const MAX_COMMAND = 10000;

export const bashTool = async (input: Record<string, unknown>, ctx: ToolContext, abort: Abort, onOutput: ((text: string) => void) | null): Promise<ToolOutcome> => {
  const command = str(input["command"]);
  if (command.trim().length === 0) return ToolOutcome.failed("no command given");
  if (command.length > MAX_COMMAND) return ToolOutcome.failed("the command is longer than " + String(MAX_COMMAND) + " characters");
  const timeoutMs = Math.max(1000, Math.min(MAX_MS, Math.floor(num(input["timeout"], DEFAULT_MS))));
  const output = new CappedText(20000, 10000);
  const end = await runBash(command, ctx.cwd, timeoutMs, output, onOutput, abort);
  const out = new ToolOutcome();
  const text = output.text();
  const notes: string[] = [];
  if (end.error.length > 0) notes.push("[" + end.error + "]");
  if (end.timedOut) notes.push("[timed out after " + String(Math.round(timeoutMs / 1000)) + " s]");
  else if (abort.aborted) notes.push("[interrupted]");
  else if (end.code !== 0) notes.push("[exit code " + String(end.code) + "]");
  out.text = (text.length > 0 ? text.replace(/\n$/, "") : "(no output)") + (notes.length > 0 ? "\n" + notes.join("\n") : "");
  out.isError = end.error.length > 0 || end.timedOut || (end.code !== 0 && !abort.aborted);
  out.rawOutputJson = objectText(["output", "exitCode", "timedOut"], [JSON.stringify(text), String(end.code), end.timedOut ? "true" : "false"]);
  return out;
};
