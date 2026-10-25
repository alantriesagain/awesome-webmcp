// The line diff: the hunks from an old text to a new one (an insertion, a deletion, a
// replacement, changes close together sharing a hunk, far apart in two), a new file, no change,
// the unified text with the file's line numbers and the counts.
import { counts, hunksOf, unifiedPatch } from "../tools/patch.ts";
import { done, eq } from "@light/test/assert.ts";

const show = (oldText: string, newText: string): string => hunksOf(oldText, newText).map((h) => String(h.oldStart) + "," + String(h.newStart) + ": " + h.lines.join("|")).join(" / ");
const ten = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].join("\n") + "\n";
eq("an insertion with three lines of context", show(ten, ten.replace("l8\n", "l8\nnew\n")), "6,6:  l6| l7| l8|+new| l9| l10");
eq("a deletion", show(ten, ten.replace("l2\n", "")), "1,1:  l1|-l2| l3| l4| l5");
eq("a replacement", show(ten, ten.replace("l5", "five")), "2,2:  l2| l3| l4|-l5|+five| l6| l7| l8");
eq("changes close together share a hunk, far apart make two", show(ten, ten.replace("l1\n", "one\n").replace("l10", "ten")), "1,1: -l1|+one| l2| l3| l4 / 7,7:  l7| l8| l9|-l10|+ten");
eq("a new file", show("", "a\nb\n"), "1,1: +a|+b");
eq("no change", show(ten, ten), "");
eq("the unified text", unifiedPatch("x.txt", hunksOf("a\nb\nc\n", "a\nB\nc\n")), "--- a/x.txt\n+++ b/x.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
const n = counts(hunksOf(ten, ten.replace("l1\n", "one\n").replace("l10", "ten") + "more\n"));
eq("the counts", String(n.added) + "+ " + String(n.removed) + "-", "3+ 2-");
done();
