// The Bash tools: a command run in the folder, its whole output written to a file under the
// session's output folder and 30 KB of it kept in the result; a command started in the background
// answers at once and its end reaches the session as a message; BashOutput reads one's output,
// BashStop ends it. A foreground call has a timeout of 120 s by default and 600 s at most; a
// background one runs up to 4 h and is stopped with its process group.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { objectText, num, str } from "@lightstart/lib/json.ts";
import { Abort } from "../loop/abort.ts";
import { BashRun, CappedText } from "./proc.ts";
import { ToolContext, ToolOutcome } from "./tool.ts";

const DEFAULT_MS = 120000;
const MAX_MS = 600000;
const BACKGROUND_MS = 4 * 60 * 60 * 1000;
const MAX_COMMAND = 10000;

const outputPathOf = (ctx: ToolContext, name: string): string => (ctx.outputDir.length > 0 && name.length > 0 ? join(ctx.outputDir, name + ".log") : "");

const startBackground = (command: string, input: Record<string, unknown>, ctx: ToolContext): ToolOutcome => {
  const jobs = ctx.jobs;
  if (jobs === null) return ToolOutcome.failed("background commands are not available in this session");
  if (jobs.runningCount() >= jobs.max) return ToolOutcome.failed("this session already has " + String(jobs.max) + " background commands running: wait for one to end, or stop one with BashStop");
  const timeoutMs = Math.max(1000, Math.min(BACKGROUND_MS, Math.floor(num(input["timeout"], BACKGROUND_MS))));
  const job = jobs.start(command, ctx.cwd, timeoutMs, ctx.outputDir);
  const o = new ToolOutcome();
  o.text = "Started " + job.id + " in the background. Its output is in " + (job.path.length > 0 ? job.path : "(not kept)") + "; its end arrives as a message.";
  o.rawOutputJson = objectText(["backgroundId", "outputPath"], [JSON.stringify(job.id), JSON.stringify(job.path)]);
  return o;
};

export const bashTool = async (input: Record<string, unknown>, ctx: ToolContext, abort: Abort, onOutput: ((text: string) => void) | null): Promise<ToolOutcome> => {
  const command = str(input["command"]);
  if (command.trim().length === 0) return ToolOutcome.failed("no command given");
  if (command.length > MAX_COMMAND) return ToolOutcome.failed("the command is longer than " + String(MAX_COMMAND) + " characters");
  if (input["run_in_background"] === true) return startBackground(command, input, ctx);
  const timeoutMs = Math.max(1000, Math.min(MAX_MS, Math.floor(num(input["timeout"], DEFAULT_MS))));
  const output = new CappedText(20000, 10000);
  const path = outputPathOf(ctx, ctx.callId);
  const run = new BashRun(command, ctx.cwd, timeoutMs, output, onOutput, abort, path);
  const end = await run.done;
  const out = new ToolOutcome();
  const text = output.text();
  const notes: string[] = [];
  if (end.error.length > 0) notes.push("[" + end.error + "]");
  if (end.timedOut) notes.push("[timed out after " + String(Math.round(timeoutMs / 1000)) + " s]");
  else if (abort.aborted) notes.push("[interrupted]");
  else if (end.code !== 0) notes.push("[exit code " + String(end.code) + "]");
  if (output.omitted > 0 && path.length > 0) notes.push("[the whole output is in " + path + "]");
  out.text = (text.length > 0 ? text.replace(/\n$/, "") : "(no output)") + (notes.length > 0 ? "\n" + notes.join("\n") : "");
  out.isError = end.error.length > 0 || end.timedOut || (end.code !== 0 && !abort.aborted);
  out.rawOutputJson = objectText(["output", "exitCode", "timedOut"], [JSON.stringify(text), String(end.code), end.timedOut ? "true" : "false"]);
  return out;
};

/** BashOutput: a background command's output so far (from `since` characters, or its last `tail` lines), whether it runs, its exit code when done. */
export const bashOutputTool = (input: Record<string, unknown>, ctx: ToolContext): ToolOutcome => {
  const id = str(input["id"]).trim();
  const job = ctx.jobs !== null ? ctx.jobs.find(id) : null;
  if (job === null) return ToolOutcome.failed("no background command named " + (id.length > 0 ? id : "(none)"));
  let text = "";
  if (job.path.length > 0 && existsSync(job.path)) {
    try {
      text = readFileSync(job.path, "utf8");
    } catch {
      text = "";
    }
  }
  const since = Math.floor(num(input["since"], -1));
  if (since > 0) text = text.slice(since);
  const tail = Math.floor(num(input["tail"], -1));
  if (tail > 0) {
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    text = lines.slice(Math.max(0, lines.length - tail)).join("\n");
  }
  const status = job.isRunning() ? "is running" : job.isStopped() ? "was stopped" : "exited " + String(job.exitCode());
  const o = new ToolOutcome();
  o.text = "[background command " + job.id + " " + status + "]\n" + (text.length > 0 ? text.replace(/\n$/, "") : "(no output)") + "\nFile: " + job.path;
  o.rawOutputJson = objectText(["running", "exitCode", "outputPath"], [job.isRunning() ? "true" : "false", String(job.exitCode()), JSON.stringify(job.path)]);
  return o;
};

/** BashStop: end a background command and the process group it started. */
export const bashStopTool = (input: Record<string, unknown>, ctx: ToolContext): ToolOutcome => {
  const id = str(input["id"]).trim();
  const jobs = ctx.jobs;
  const job = jobs !== null ? jobs.find(id) : null;
  if (job === null) return ToolOutcome.failed("no background command named " + (id.length > 0 ? id : "(none)"));
  const o = new ToolOutcome();
  if (!job.isRunning()) {
    o.text = job.id + " has already ended (" + (job.isStopped() ? "stopped" : "exit code " + String(job.exitCode())) + ").";
    return o;
  }
  if (jobs !== null) jobs.stop(job);
  o.text = "Stopped " + job.id + ".";
  return o;
};
