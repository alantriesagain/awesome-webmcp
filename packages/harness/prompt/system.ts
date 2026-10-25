// The system prompt's blocks. The stable ones first, cached by a provider that caches: the base
// text (who the agent is, how it works with its tools), the folder and platform, the project's
// text the ACP client passes (widecode's fixed paragraph and the project's prompt.md), the
// project's instructions (AGENTS.md and the like, a trusted folder's) and the skills offered.
// Then one small block that changes: the date and the mode's note, which the loop sends last and
// uncached.
import { join } from "node:path";
import { contextFiles, contextSection } from "./context-files.ts";
import { scanSkills, skillsSection } from "./skills.ts";

const BASE =
  "You are the harness, widecode's coding agent, working in the user's project folder from a terminal. " +
  "Read before you change, keep changes small and explain what you did in a few plain sentences. " +
  "Answer in terse markdown. Never claim to have done what you did not do.\n\n" +
  "Tools: Read a file before you Edit or Write it; prefer Edit for a change to part of a file. Bash runs a command in the folder with a timeout: no interactive commands, nothing that waits for input. " +
  "Grep searches the files' text, Glob finds files by name, LS lists a folder. Independent read-only calls can go in one reply; they run together. " +
  "When a decision is the user's, ask it with mcp__widecode__AskUser when you have it, instead of guessing.";

/** What the stable blocks are made of. */
export class SystemFacts {
  cwd = "";
  platform = "";
  /** The project's text from the client ("" for none). */
  harnessText = "";
  trusted = false;
  /** The user's home ("" for none: no user skills) and the harness's folder under the store. */
  home = "";
  harnessRoot = "";
}

/** The stable blocks for a session. */
export const systemBlocks = (f: SystemFacts): string[] => {
  const out: string[] = [BASE + "\n\nThe folder: " + f.cwd + "\nThe platform: " + f.platform];
  if (f.harnessText.trim().length > 0) out.push(f.harnessText.trim());
  const context = contextSection(contextFiles(f.cwd, f.trusted, f.harnessRoot.length > 0 ? join(f.harnessRoot, "AGENTS.md") : ""));
  const skills = skillsSection(scanSkills(f.cwd, f.trusted, f.home, f.harnessRoot));
  const tail = [context, skills].filter((s) => s.length > 0).join("\n\n");
  if (tail.length > 0) out.push(tail);
  return out;
};

/** The block that changes: today's date, and in plan mode what the mode allows (`planTool` the tool that presents the plan, "" for none). */
export const turnNote = (date: string, mode: string, planTool: string): string => {
  const today = "Today is " + date + ".";
  if (mode !== "plan") return today;
  return today + " Plan mode: only the read-only tools are offered. Explore and think, change nothing" + (planTool.length > 0 ? ", and when the plan is ready present it with " + planTool + " and wait for the answer." : ", and give the plan as your answer.");
};
