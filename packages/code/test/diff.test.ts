// The code column's loader on a temp repository: a modified file's lines with HEAD's in place, a
// deleted one all removed, a new one (staged, untracked, in a repository without a commit) as plain
// code marked new, a binary one, a folder outside git; the unified-diff parser, change starts and
// tab expansion.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDED, CodeFile, CodeLine, expandTabs, hunkStarts, KEPT, loadCode, loadCommitFile, parseUnified, REMOVED } from "../diff.ts";
import { openRepo } from "@light/workspace/git.ts";
import { Commit } from "@light/workspace/git-log.ts";
import { done, eq } from "@light/test/assert.ts";
import { registerLanguages } from "@lightstart/highlight/languages.ts";

registerLanguages();

const sign = (l: CodeLine): string => (l.kind === ADDED ? "+" : l.kind === REMOVED ? "-" : " ");
const show = (f: CodeFile): string => f.lines.map((l) => sign(l) + String(l.oldNo) + ":" + String(l.newNo) + " " + l.text).join("|");

eq("tabs to four-column stops", expandTabs("\tx\ty") + "|" + expandTabs("ab\tc"), "    x   y|ab  c");
eq("tabs count a wide character as two cells", expandTabs("猫\tx"), "猫  x");
const parsed = parseUnified("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file\n");
eq("a unified diff", parsed.map((l) => sign(l) + l.text).join("|"), " a|-b|+B| c");
eq("its line numbers", parsed.map((l) => String(l.oldNo) + ":" + String(l.newNo)).join(" "), "1:1 2:0 0:2 3:3");
eq("change starts", hunkStarts([new CodeLine(KEPT, 1, 1, ""), new CodeLine(REMOVED, 2, 0, ""), new CodeLine(ADDED, 0, 2, ""), new CodeLine(KEPT, 3, 3, ""), new CodeLine(ADDED, 0, 4, "")]).join(","), "1,4");

const root = mkdtempSync(join(tmpdir(), "code-diff-"));
const git = (dir: string, args: string[]): void => {
  const all = ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main"];
  for (const a of args) all.push(a);
  spawnSync("git", all, { encoding: "utf8" });
};
writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nfour\n");
writeFileSync(join(root, "gone.txt"), "x\ny\n");
writeFileSync(join(root, "same.txt"), "same\n");
writeFileSync(join(root, "app.js"), "const a = 1;\nconst b = `x\ny`;\n");
git(root, ["init", "-q"]);
git(root, ["add", "."]);
git(root, ["commit", "-qm", "init"]);
writeFileSync(join(root, "a.txt"), "one\nTWO\nthree\nfour\nfive\n");
writeFileSync(join(root, "app.js"), "const a = 2;\nconst b = `x\ny`;\n");
rmSync(join(root, "gone.txt"));
writeFileSync(join(root, "staged.txt"), "s1\ns2\n");
git(root, ["add", "staged.txt"]);
writeFileSync(join(root, "new.txt"), "n1\n\tn2\n");
writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2]));

const main = async (): Promise<void> => {
  const repo = await openRepo(root);
  const a = await loadCode(repo, root, "a.txt", false, "HEAD");
  eq("modified: HEAD's line in place, the new ones added", show(a), " 1:1 one|-2:0 two|+0:2 TWO| 3:3 three| 4:4 four|+0:5 five");
  eq("its changes", a.hunks.join(","), "1,5");
  eq("deleted: all removed", show(await loadCode(repo, root, "gone.txt", false, "HEAD")), "-1:0 x|-2:0 y");
  const isNew = (f: CodeFile): string => (f.added ? "new " : "") + String(f.hunks.length) + " changes: " + show(f);
  eq("staged new: plain, marked new", isNew(await loadCode(repo, root, "staged.txt", false, "HEAD")), "new 0 changes:  0:1 s1| 0:2 s2");
  eq("untracked: plain, marked new, tabs expanded", isNew(await loadCode(repo, root, "new.txt", true, "HEAD")), "new 0 changes:  0:1 n1| 0:2     n2");
  eq("a changed file is not new", String((await loadCode(repo, root, "a.txt", false, "HEAD")).added), "false");
  eq("unchanged: all kept", show(await loadCode(repo, root, "same.txt", false, "HEAD")), " 1:1 same");
  const bin = await loadCode(repo, root, "bin.dat", true, "HEAD");
  eq("binary", String(bin.binary) + " " + bin.note + " " + String(bin.lines.length), "true binary file 0");
  eq("outside the folder", (await loadCode(repo, root, "../x", false, "HEAD")).note, "outside the folder");
  eq("a commit's file outside the folder", (await loadCommitFile(repo, root, new Commit(), "../x")).note, "outside the folder");
  const js = await loadCode(repo, root, "app.js", false, "HEAD");
  const types = (l: CodeLine): string => l.tokens.map((t) => t.type.charAt(0) + t.type.charAt(1)).join(" ");
  eq("a .js file's lines carry tokens: removed, added, kept", js.lines.map(types).join(" | "), "ke de op nu pu | ke de op nu pu | ke de op st | st pu");
  eq("a .txt file has none", (await loadCode(repo, root, "a.txt", false, "HEAD")).lines.every((l) => l.tokens.length === 0) ? "plain" : "colored", "plain");

  const plain = mkdtempSync(join(tmpdir(), "code-plain-"));
  writeFileSync(join(plain, "p.txt"), "p1\np2\n");
  eq("outside git: plain", show(await loadCode(await openRepo(plain), plain, "p.txt", false, "HEAD")), " 1:1 p1| 2:2 p2");
  git(plain, ["init", "-q"]);
  eq("no commit yet: new", isNew(await loadCode(await openRepo(plain), plain, "p.txt", false, "HEAD")), "new 0 changes:  0:1 p1| 0:2 p2");
  rmSync(plain, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  done();
};

main();
