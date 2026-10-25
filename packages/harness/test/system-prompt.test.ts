// node-only
// The system prompt's stable blocks over a temp repository: the base text with the folder and
// platform, the project's text, then the instructions from the repository's root down to the
// folder (a CLAUDE.md with AGENTS.md's text left out), the harness's own AGENTS.md last, and the
// skills; an untrusted folder's instructions left out; the turn's note in build and plan mode.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextFiles, foldersDown } from "../prompt/context-files.ts";
import { SystemFacts, systemBlocks, turnNote } from "../prompt/system.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const root = mkdtempSync(join(tmpdir(), "harness-prompt-"));
const repo = join(root, "repo");
const sub = join(repo, "packages", "app");
mkdirSync(join(repo, ".git"), { recursive: true });
mkdirSync(join(sub, ".claude"), { recursive: true });
writeFileSync(join(repo, "AGENTS.md"), "Root rules.\n");
writeFileSync(join(repo, "CLAUDE.md"), "Root rules.\n");
writeFileSync(join(sub, "AGENTS.md"), "App rules.\n");
writeFileSync(join(sub, ".claude", "CLAUDE.md"), "App's Claude rules.\n");
const harness = join(root, "store", "harness");
mkdirSync(join(harness, "skills", "tidy"), { recursive: true });
writeFileSync(join(harness, "AGENTS.md"), "The user's own rules.\n");
writeFileSync(join(harness, "skills", "tidy", "SKILL.md"), "---\ndescription: Tidy the code\n---\nTidy.\n");

eq("the folders from the repository's root down", foldersDown(sub).map((d) => d.slice(root.length)).join(" "), "/repo /repo/packages /repo/packages/app");
eq("a folder outside a repository is itself", foldersDown(root).map((d) => d.slice(root.length)).join(" ") + "|", "|");
eq("the files: the root's (its CLAUDE.md the same text), the folder's, then the user's", contextFiles(sub, true, join(harness, "AGENTS.md")).map((f) => f.path.slice(root.length) + "=" + f.text).join(" "), "/repo/AGENTS.md=Root rules. /repo/packages/app/AGENTS.md=App rules. /repo/packages/app/.claude/CLAUDE.md=App's Claude rules. /store/harness/AGENTS.md=The user's own rules.");
eq("untrusted: the user's alone", contextFiles(sub, false, join(harness, "AGENTS.md")).map((f) => f.text).join(" "), "The user's own rules.");

const f = new SystemFacts();
f.cwd = sub;
f.platform = "linux";
f.harnessText = "  You are running inside widecode.  ";
f.trusted = true;
f.harnessRoot = harness;
const blocks = systemBlocks(f);
eq("three blocks: the base, the project's text, the instructions and skills", String(blocks.length), "3");
ok("the base names the folder and platform", blocks[0].startsWith("You are the harness, widecode's coding agent") && blocks[0].endsWith("\n\nThe folder: " + sub + "\nThe platform: linux"));
eq("the project's text, trimmed", blocks[1], "You are running inside widecode.");
ok("the instructions in file tags, the user's last, then the skills", blocks[2].startsWith("The project's instructions, which you follow:\n\n<file path=\"" + join(repo, "AGENTS.md") + "\">\nRoot rules.\n</file>") && blocks[2].includes("<file path=\"" + join(harness, "AGENTS.md") + "\">\nThe user's own rules.\n</file>\n\nSkills: ") && blocks[2].endsWith("\n- tidy: Tidy the code"));
f.harnessText = "";
f.trusted = false;
f.harnessRoot = "";
eq("untrusted, no project text, no harness folder: the base alone", String(systemBlocks(f).length), "1");

eq("the note in build mode: the date", turnNote("2026-10-25", "build", "mcp__widecode__PresentPlan"), "Today is 2026-10-25.");
eq("in plan mode: what the mode allows, the plan's tool", turnNote("2026-10-25", "plan", "mcp__widecode__PresentPlan"), "Today is 2026-10-25. Plan mode: only the read-only tools are offered. Explore and think, change nothing, and when the plan is ready present it with mcp__widecode__PresentPlan and wait for the answer.");
eq("without one", String(turnNote("2026-10-25", "plan", "").endsWith("change nothing, and give the plan as your answer.")), "true");
rmSync(root, { recursive: true, force: true });
done();
