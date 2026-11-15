// Globs over relative paths: a segment's star, two stars for any depth, a question mark, a
// brace, a class, a bare name matching at any depth, a dot kept literal.
import { globMatches, globToRegExp } from "../src/harness/tools/glob-match.ts";
import { done, eq } from "@lightstart/test/assert.ts";

const m = (pattern: string, paths: string[]): string => paths.map((p) => (globMatches(pattern, p) ? "1" : "0")).join("");
eq("a star within a segment", m("src/*.ts", ["src/a.ts", "src/deep/b.ts", "a.ts"]), "100");
eq("two stars for any depth, none included", m("src/**/*.ts", ["src/a.ts", "src/deep/b.ts", "lib/c.ts"]), "110");
eq("two stars alone", m("**/*.md", ["README.md", "docs/a.md", "a.txt"]), "110");
eq("a question mark", m("a?.ts", ["ab.ts", "abc.ts"]), "10");
eq("a brace", m("*.{ts,js}", ["a.ts", "b.js", "c.md"]), "110");
eq("a class", m("[ab].ts", ["a.ts", "c.ts"]), "10");
eq("a bare name matches at any depth", m("package.json", ["package.json", "pkg/x/package.json", "package.jsonx"]), "110");
eq("a dot is literal", m("*.ts", ["a.ts", "ats"]), "10");
eq("the expression anchors both ends", String(globToRegExp("src/**/*.ts").test("xsrc/a.ts")) + String(globToRegExp("src/**/*.ts").test("src/a.tsx")), "falsefalse");
done();
