// ffi: @lightstart/plugins/native/ffi.json
// The app's built-in plugin sources evaluate at top level under the harness's prelude: they read
// lightcode.util, lightcode.theme and lightcode.version without throwing, so the daemon can load the
// same files the app does. The test reads them as the app's prepare step wrote them for a test run,
// dist/plugins-test/<id>/,
// and evaluates each as the harness does: its folder's files registered, its index.js an ES module.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleFilesOf } from "@lightstart/plugins/sources.ts";
import { HostAnswer, HostHandler, JsEngine, OK } from "@lightstart/plugins/engine.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { EXT_PRELUDE } from "../src/harness/ext/prelude.ts";

class Quiet extends HostHandler {
  override answer(name: string, args: string): HostAnswer {
    void name;
    void args;
    return new HostAnswer(OK, "null");
  }
}

class BuiltinSource {
  readonly name: string;
  readonly code: string;

  constructor(name: string, code: string) {
    this.name = name;
    this.code = code;
  }
}

const main = async (): Promise<void> => {
  const built = join(process.cwd(), "dist", "plugins-test");
  const sources: BuiltinSource[] = [];
  for (const id of existsSync(built) ? readdirSync(built).sort() : []) {
    const index = join(built, id, "index.js");
    if (existsSync(index)) sources.push(new BuiltinSource(index, readFileSync(index, "utf8")));
  }
  const engine = new JsEngine(new Quiet(), 32, 1000);
  const prelude = engine.eval(EXT_PRELUDE, "harness:plugin-prelude");
  eq("the prelude evaluates", String(prelude.status), String(OK));
  let failed = "";
  for (const source of sources) {
    engine.eval("__extFile(" + JSON.stringify(source.name) + ")", "harness:plugin-file");
    for (const f of moduleFilesOf(source.name)) engine.addModule(f.file, f.code);
    const evaluated = engine.evalModule(source.code, source.name + "#1");
    if (evaluated.status !== OK && failed.length === 0) failed = source.name + ": " + evaluated.message();
  }
  ok("there are built-in plugins to evaluate", sources.length > 0);
  eq("every built-in plugin evaluates at top level", failed, "");
  engine.free();
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
