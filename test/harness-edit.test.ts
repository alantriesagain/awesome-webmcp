// Write and Edit over a temp folder: a file written new and shown as created, one that exists
// refused until read, then written with the diff; an edit's unique match, the patch with line
// numbers as the result and the outcome's change, not found, ambiguous with the lines, replace
// all, a CRLF file kept CRLF, the mode kept, an empty old string, a file not read first, a file
// that is not there.
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Abort } from "../src/harness/loop/abort.ts";
import { ToolContext, ToolOutcome, ToolSet, builtInTools } from "../src/harness/tools/tool.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "harness-edit-"));
  const ten = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "one", "l9", "l10"].join("\n") + "\n";
  writeFileSync(join(folder, "a.txt"), ten);
  writeFileSync(join(folder, "win.txt"), "a\r\nb\r\nc\r\n");
  chmodSync(join(folder, "a.txt"), 0o640);
  const tools = new ToolSet(builtInTools());
  const reads = new Set<string>();
  const ctx = new ToolContext(folder, "build", reads);
  const abort = new Abort();
  const run = (name: string, input: unknown): Promise<ToolOutcome> => tools.run(name, JSON.stringify(input), ctx, abort, null);
  const text = async (name: string, input: unknown): Promise<string> => {
    const o = await run(name, input);
    return (o.isError ? "ERR " : "") + o.text;
  };

  const made = await run("Write", { file_path: "new/b.txt", content: "x\ny\n" });
  eq("a new file written, its folders made", made.text + " · " + readFileSync(join(folder, "new/b.txt"), "utf8").replace(/\n/g, "|"), "Created new/b.txt (2 lines) · x|y|");
  ok("shown as created with its patch", made.created && made.oldText === "" && made.newText === "x\ny\n" && made.patch === "--- a/new/b.txt\n+++ b/new/b.txt\n@@ -1,0 +1,2 @@\n+x\n+y\n" && made.rawOutputJson.includes('"additions":2,"deletions":0'));
  eq("a file that exists is refused until read", await text("Write", { file_path: "a.txt", content: "z\n" }), "ERR a.txt exists and was not read in this session: read it first, then write or edit it");
  writeFileSync(join(folder, "c.txt"), "alpha\nbeta\nalpha\n");
  eq("a file not read: text found more than once is refused", await text("Edit", { file_path: "c.txt", old_string: "alpha", new_string: "x" }), "ERR c.txt was not read in this session: read it first, or give an old_string that occurs once in it");
  eq("replace_all as well", await text("Edit", { file_path: "c.txt", old_string: "alpha", new_string: "x", replace_all: true }), "ERR c.txt was not read in this session: read it first, or give an old_string that occurs once in it");
  eq("text found once is replaced", (await text("Edit", { file_path: "c.txt", old_string: "beta", new_string: "gamma" })).split("\n")[0] + " · " + readFileSync(join(folder, "c.txt"), "utf8").replace(/\n/g, "|"), "Edited c.txt (1 replacement) · alpha|gamma|alpha|");
  await run("Read", { file_path: "a.txt" });
  const edited = await run("Edit", { file_path: "a.txt", old_string: "one", new_string: "one\ntwo" });
  eq("an edit: the patch with the file's line numbers as the result", edited.text, "Edited a.txt (1 replacement)\n@@ -6,5 +6,6 @@\n l6\n l7\n one\n+two\n l9\n l10\n");
  ok("the outcome's change", edited.diffPath === join(folder, "a.txt") && !edited.created && edited.oldText === ten && edited.newText === ten.replace("one\n", "one\ntwo\n") && edited.rawOutputJson.includes('"additions":1,"deletions":0'));
  eq("the mode kept", (statSync(join(folder, "a.txt")).mode & 0o777).toString(8), "640");
  eq("not found", await text("Edit", { file_path: "a.txt", old_string: "nope", new_string: "x" }), "ERR old_string not found in a.txt");
  eq("ambiguous, with the lines", await text("Edit", { file_path: "a.txt", old_string: "l", new_string: "L" }), "ERR old_string occurs 3 or more times in a.txt (lines 1, 2, 3): make it unique with more context, or set replace_all");
  eq("replace all", (await text("Edit", { file_path: "a.txt", old_string: "l1", new_string: "L1", replace_all: true })).split("\n")[0], "Edited a.txt (2 replacements)");
  eq("an empty old string", await text("Edit", { file_path: "a.txt", old_string: "", new_string: "x" }), "ERR old_string is empty: use Write for a new file");
  eq("the same strings", await text("Edit", { file_path: "a.txt", old_string: "x", new_string: "x" }), "ERR old_string and new_string are the same");
  eq("a file that is not there", await text("Edit", { file_path: "gone.txt", old_string: "a", new_string: "b" }), "ERR gone.txt does not exist: use Write for a new file");
  await run("Read", { file_path: "win.txt" });
  const win = await run("Edit", { file_path: "win.txt", old_string: "b\nc", new_string: "B\nC\nD" });
  eq("a CRLF file edited with LF strings stays CRLF", JSON.stringify(readFileSync(join(folder, "win.txt"), "utf8")) + " " + String(win.isError), '"a\\r\\nB\\r\\nC\\r\\nD\\r\\n" false');
  const over = await run("Write", { file_path: "a.txt", content: "fresh\n" });
  ok("a read file written whole, with the diff from what was there", !over.isError && over.text === "Wrote a.txt (1 line)" && over.oldText.startsWith("L1\n") && over.newText === "fresh\n" && over.patch.includes("+fresh"));
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
