// An extension's source as the engine takes it: pi's module shape made a script. One textual pass
// turns `export default` into the assignment the prelude reads, drops `export` before a declaration,
// and refuses an import with the file and the line, since the harness runs extensions without Node.
// The result is wrapped in a function of its own, as widecode's runtime wraps a plugin, so each
// file has its own top-level names.
import { PluginSource } from "@light/plugins/sources.ts";

/** A file's source after the pass, or why it cannot load. */
export class ExtSource {
  readonly file: string;
  code = "";
  error = "";

  constructor(file: string) {
    this.file = file;
  }
}

const IMPORT_MESSAGE = "imports are not supported: the harness runs extensions without Node";

/** The line an import starts on, 0 when none does. */
const importLine = (text: string): number => {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) if (/^\s*import\s/.test(lines[i])) return i + 1;
  return 0;
};

/** `source` after the pass, wrapped for the engine; `error` set when it cannot load. */
export const extSource = (source: PluginSource): ExtSource => {
  const out = new ExtSource(source.file);
  const line = importLine(source.code);
  if (line > 0) {
    out.error = source.file + ":" + String(line) + ": " + IMPORT_MESSAGE;
    return out;
  }
  let code = source.code.replace(/^(\s*)export\s+default\s+/gm, "$1__ext.main = ");
  code = code.replace(/^(\s*)export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm, "$1");
  out.code = "(function () {\n" + code + "\n})();";
  return out;
};
