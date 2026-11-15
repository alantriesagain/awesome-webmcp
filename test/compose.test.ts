// The composer's helpers: the @token at the caret, path matching (a name that starts with the
// query first), and images attached by reference (a chip in the text, sent as base64 blocks, their
// file kept for a press; a missing or oversized one refused; other references left for the CLI).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachImages, IMAGE_MAX, mediaTypeOf } from "../src/conversation/attach.ts";
import { atToken, matchPaths } from "../src/chat/suggest.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const tok = (line: string, col: number): string => {
  const t = atToken(line, col);
  return t === null ? "none" : String(t.start) + ":" + t.query;
};
eq("a token at the caret", tok("look at @src/ap", 15), "8:src/ap");
eq("the caret right after @", tok("see @", 5), "4:");
eq("no token after a space", tok("see @src now", 12), "none");
eq("an email is not a token", tok("me@host", 7), "none");
eq("a token before the caret's end", tok("@abc def", 4), "0:abc");

const paths = ["src/app.js", "src/lib/apply.ts", "README.md", "docs/app-notes.md", "test/zap.test.ts"];
eq("names starting with the query, shorter paths first", matchPaths(paths, "ap", 3).join(","), "src/app.js,src/lib/apply.ts,docs/app-notes.md");
eq("a name that starts with it before a path that does", matchPaths(paths.concat(["src/test-utils.ts"]), "test", 5).join(","), "src/test-utils.ts,test/zap.test.ts");
eq("letters in order match too", matchPaths(paths, "zts", 5).join(","), "test/zap.test.ts");
eq("an empty query lists the shortest", matchPaths(paths, "", 2).join(","), "README.md,src/app.js");

eq("image types by extension", mediaTypeOf("a.PNG") + " " + mediaTypeOf("b.jpeg") + " " + mediaTypeOf("c.txt"), "image/png image/jpeg ");
const dir = mkdtempSync(join(tmpdir(), "code-compose-"));
writeFileSync(join(dir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(join(dir, "two.jpg"), Buffer.from([0xff, 0xd8]));
const a = attachImages("what is in @pic.png and @src/app.js", dir);
eq("the image becomes a block and a chip in the text", a.text + " | " + String(a.images.length) + " " + (a.images.length > 0 ? a.images[0].mediaType + " " + a.images[0].data : ""), "what is in [Image #1] and @src/app.js | 1 image/png iVBORw==");
eq("its file is kept, for a chip's press", a.images[0]?.path ?? "", join(dir, "pic.png"));
const p2 = attachImages(join(dir, "pic.png") + " and file://" + join(dir, "two.jpg"), dir);
eq("bare and file:// paths a file manager copied, numbered in order", p2.text + " " + p2.images.map((i) => i.path.split("/").pop()).join(","), "[Image #1] and [Image #2] pic.png,two.jpg");
writeFileSync(join(dir, "a shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
eq("a copied path with spaces, a whole line", attachImages(join(dir, "a shot.png"), dir).text, "[Image #1]");
eq("several, one per line", attachImages(join(dir, "a shot.png") + "\n" + join(dir, "pic.png"), dir).text, "[Image #1]\n[Image #2]");
const quoted = attachImages("what is this '" + join(dir, "a shot.png") + "'", dir);
eq("a quoted path beside text, as an expanded chip", quoted.text + " " + String(quoted.images.length), "what is this [Image #1] 1");
writeFileSync(join(dir, "code.ts"), "const x = 1;\n");
const f = attachImages(join(dir, "code.ts"), dir);
eq("another file stays the path for the agent", f.text + " " + String(f.images.length), join(dir, "code.ts") + " 0");
ok("a missing image is refused", attachImages("@nope.png", dir).error.startsWith("no image at"));
writeFileSync(join(dir, "big.png"), Buffer.alloc(IMAGE_MAX + 1));
ok("an oversized image is refused", attachImages("@big.png", dir).error.includes("is over"));
rmSync(dir, { recursive: true, force: true });
done();
