// The TUI's code view would color code with @bootstrapp/editor's pure tokenizers and could diff
// with its Myers core. Does that JavaScript compile statically? Tokenize a JS line and a CSS line,
// diff two texts; prints the same under node and natively.
import { languageForPath } from "../../bootstrapp/packages/editor/lang/index.js";
import { tokenizeAll } from "../../bootstrapp/packages/editor/lang/annotate.js";
import { diffLines } from "../../bootstrapp/packages/editor/diff.js";

const show = (path: string, text: string): void => {
  const lang = languageForPath(path);
  if (lang === null) {
    console.log(path + ": no language");
    return;
  }
  const lines = tokenizeAll(lang, text);
  for (const l of lines) console.log(path + ": " + l.tokens.map((t) => t.type + "[" + String(t.from) + "," + String(t.to) + ")").join(" "));
};
show("a.js", "const answer = 42; // done");
show("b.css", ".x { color: red; }");
show("c.md", "# Title\nsome `code` here");
const hunks = diffLines(["a", "b", "c", "d"], ["a", "B", "c", "d", "e"]);
console.log(hunks.map((h) => h.type + ":" + String(h.aFrom) + "-" + String(h.aTo) + "/" + String(h.bFrom) + "-" + String(h.bTo)).join(" "));
