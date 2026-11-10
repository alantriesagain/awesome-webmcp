// ffi: @light/plugins/native/ffi.json
// The source pass: a default export in each form becomes the assignment the prelude reads,
// declarations lose their `export`, a file's own scope comes from the wrapper, and an import is
// refused naming the file and the line.
import "@light/plugins/engine.ts";
import { PluginSource } from "@light/plugins/sources.ts";
import { extSource } from "../ext/source.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const pass = (code: string): string => extSource(new PluginSource("x.js", code)).code;

eq(
  "every default export form becomes __ext.main",
  ["export default function (pi) {}", "export default function named(pi) {}", "export default async function named(pi) {}", "export default (pi) => {}"].map((code) => pass(code).includes("__ext.main = ")).join(","),
  "true,true,true,true",
);
ok("the default export is the wrapped file's assignment", pass("export default function (pi) {}").includes("(function () {\n__ext.main = function (pi) {}\n})();"));
eq("export before a declaration is dropped", pass("export const a = 1;\nexport let b = 2;\nexport function f() {}\nexport class C {}\nexport async function g() {}"), "(function () {\nconst a = 1;\nlet b = 2;\nfunction f() {}\nclass C {}\nasync function g() {}\n})();");
eq("a default export and a declaration together", pass("export default async function (pi) {}\nexport const x = 1;").includes("__ext.main = async function (pi) {}") + " " + pass("export default async function (pi) {}\nexport const x = 1;").includes("const x = 1;"), "true true");
const refused = extSource(new PluginSource("/tmp/ext/a.js", "const a = 1;\n  import x from 'y';\n"));
eq("the refusal names the file and the line", refused.error, "/tmp/ext/a.js:2: imports are not supported: the harness runs extensions without Node");
eq("a file without imports has no error", extSource(new PluginSource("x.js", "export default (pi) => {}")).error, "");
done();
