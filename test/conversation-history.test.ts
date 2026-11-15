// The folder's message history: appended to .widecode/history.jsonl, walked newest first with a
// repeat in a row walked once, a message added after the walk began leading it; past its size the
// log moves aside to history.1.jsonl (an older one to .2) and the walk reads across them in order,
// nothing lost; without a folder to write in, this run's messages only.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptHistory } from "../src/conversation/history.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const walk = (h: PromptHistory): string => {
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const t = h.at(i);
    if (t === null) break;
    out.push(t);
  }
  return out.join(",");
};

const folder = mkdtempSync(join(tmpdir(), "widecode-history-"));
const dir = join(folder, ".widecode");
const h = new PromptHistory(dir);
for (const t of ["a", "b", "b", "c"]) h.add(t, "s1", 1000);
h.add("   ", "s1", 1000);
const lines = readFileSync(join(dir, "history.jsonl"), "utf8").trim().split("\n");
eq("each message a line, blank ones left out", String(lines.length) + " " + JSON.stringify((JSON.parse(lines[0]) as { session?: unknown; text?: unknown }).text), '4 "a"');
eq("walked newest first, a repeat in a row once", walk(h), "c,b,a");
h.add("d", "s2", 2000);
eq("a message added meanwhile leads", walk(h), "d,c,b,a");
eq("another run reads the same", walk(new PromptHistory(dir)), "d,c,b,a");

const small = new PromptHistory(dir);
small.maxBytes = 60;
small.add("e", "s2", 3000);
ok("past its size the log moved aside", existsSync(join(dir, "history.1.jsonl")) && readFileSync(join(dir, "history.jsonl"), "utf8").includes('"e"'));
for (const t of ["f", "g"]) small.add(t, "s2", 4000);
ok("and again: the older one to .2", existsSync(join(dir, "history.2.jsonl")));
eq("the walk reads across the files in order, nothing lost", walk(new PromptHistory(dir)), "g,f,e,d,c,b,a");

const cappedDir = join(mkdtempSync(join(tmpdir(), "widecode-history-cap-")), ".widecode");
const capped = new PromptHistory(cappedDir);
capped.maxBytes = 1;
for (let i = 0; i < 15; i++) capped.add("m" + String(i), "s", i);
const kept = readdirSync(cappedDir).filter((f) => f.startsWith("history"));
ok("older logs are capped", kept.length <= 11 && !existsSync(join(cappedDir, "history.11.jsonl")));
rmSync(cappedDir, { recursive: true, force: true });

const memory = new PromptHistory("");
memory.add("x", "", 0);
memory.add("y", "", 0);
eq("without a folder: this run's only", walk(memory) + " " + String(existsSync(join(folder, "x"))), "y,x false");
rmSync(folder, { recursive: true, force: true });
done();
