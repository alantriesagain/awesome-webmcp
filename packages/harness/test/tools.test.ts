// The tools over a temp folder: Read's numbered lines, offset and limit, a long line clipped, a
// missing file, a binary file, an absolute path; Bash's output with stderr, the exit code, the
// timeout, an abort; Grep's matches with their lines, a glob of names, no match; Glob's files
// newest first, a bare name at any depth; LS's entries; the set: plan mode's share, the tools'
// JSON, an input checked against the schema.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Abort } from "../loop/abort.ts";
import { ToolContext, ToolSet, builtInTools } from "../tools/tool.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "harness-tools-"));
  writeFileSync(join(folder, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(folder, "long.txt"), "x".repeat(2500) + "\n");
  writeFileSync(join(folder, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  const tools = new ToolSet(builtInTools());
  const ctx = new ToolContext(folder, "build", new Set<string>());
  const abort = new Abort();
  const run = async (name: string, input: string): Promise<string> => {
    const o = await tools.run(name, input, ctx, abort, null);
    return (o.isError ? "ERR " : "") + o.text;
  };
  eq("Read: numbered lines", await run("Read", '{"file_path":"a.txt"}'), "     1\tone\n     2\ttwo\n     3\tthree");
  eq("from an offset, a limit, the rest noted", await run("Read", '{"file_path":"a.txt","offset":2,"limit":1}'), "     2\ttwo\n(1 more lines: read from line 3)");
  ok("a long line clipped", (await run("Read", '{"file_path":"long.txt"}')).endsWith("…"));
  eq("a missing file", await run("Read", '{"file_path":"nope.txt"}'), "ERR cannot read nope.txt: not a file, or not readable");
  eq("a binary file", await run("Read", '{"file_path":"bin.dat"}'), "ERR bin.dat is a binary file");
  eq("an absolute path", await run("Read", JSON.stringify({ file_path: join(folder, "a.txt"), limit: 1 })), "     1\tone\n(2 more lines: read from line 2)");
  eq("Bash: the output, stderr in it", (await run("Bash", '{"command":"echo out; echo err >&2"}')).split("\n").sort().join("|"), "err|out");
  eq("the exit code when not 0, as an error", await run("Bash", '{"command":"echo x; exit 3"}'), "ERR x\n[exit code 3]");
  eq("the folder is the cwd", await run("Bash", '{"command":"cat a.txt | head -1"}'), "one");
  eq("a timeout", await run("Bash", '{"command":"sleep 5","timeout":1000}'), "ERR (no output)\n[timed out after 1 s]");
  const aborting = new Abort();
  const slow = tools.run("Bash", '{"command":"sleep 5; echo late"}', ctx, aborting, null);
  setTimeout(() => aborting.fire(), 100);
  const cut = await slow;
  eq("an abort kills the command, not an error of the tool", (cut.isError ? "ERR " : "") + cut.text, "(no output)\n[interrupted]");
  const seen: string[] = [];
  await tools.run("Bash", '{"command":"echo a; echo b"}', ctx, abort, (text: string) => seen.push(text));
  eq("the output as it comes", seen.join("").replace(/\n/g, "|"), "a|b|");
  mkdirSync(join(folder, "src", "deep"), { recursive: true });
  writeFileSync(join(folder, "src", "one.ts"), "export const one = 1;\nconst hidden = 'needle';\n");
  writeFileSync(join(folder, "src", "deep", "two.ts"), "export const two = 2; // needle\n");
  writeFileSync(join(folder, "src", "notes.md"), "needle in notes\n");
  const grep = await run("Grep", '{"pattern":"needle","path":"src"}');
  eq("Grep: file, line number and line, sorted", grep.split("\n").sort().join(" | "), "src/deep/two.ts:1:export const two = 2; // needle | src/notes.md:1:needle in notes | src/one.ts:2:const hidden = 'needle';");
  eq("a glob of names", await run("Grep", '{"pattern":"needle","include":"*.md"}'), "src/notes.md:1:needle in notes");
  eq("no match", await run("Grep", '{"pattern":"zzz"}'), "No matches for zzz");
  eq("Glob: the files of a pattern", (await run("Glob", '{"pattern":"src/**/*.ts"}')).split("\n").sort().join(","), "src/deep/two.ts,src/one.ts");
  eq("a bare name at any depth", await run("Glob", '{"pattern":"two.ts"}'), "src/deep/two.ts");
  eq("under a folder", await run("Glob", '{"pattern":"*.ts","path":"src/deep"}'), "src/deep/two.ts");
  eq("no files", await run("Glob", '{"pattern":"*.rs"}'), "No files match *.rs");
  eq("LS: the entries, folders marked", await run("LS", '{"path":"src"}'), "deep/\nnotes.md\none.ts");
  eq("the set in plan mode", tools.forMode("plan").tools.map((t) => t.name).join(","), "Read,Grep,Glob,LS");
  ok("the tools as the API takes them", tools.json(false).startsWith('[{"name":"Read","description":"Read a file') && tools.json(false).includes('"input_schema":{"type":"object","properties":{"file_path"') && !tools.json(false).includes("eager"));
  eq("an input checked: a missing field, a wrong type, not JSON, not an object, unknown tool, a good one", [tools.checkInput("Read", "{}"), tools.checkInput("Read", '{"file_path":3}'), tools.checkInput("Bash", "{nope"), tools.checkInput("Bash", "[1]"), tools.checkInput("Nope", "{}"), tools.checkInput("Bash", '{"command":"ls","timeout":5}')].join(" | "), "the input lacks file_path | file_path should be a string | the input is not valid JSON | the input is not an object | no tool named Nope | ");
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
