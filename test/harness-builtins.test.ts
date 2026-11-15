// node-only
// The app's built-in plugin sources evaluate at top level under the harness's prelude: they read
// widecode.util, widecode.theme and widecode.version without throwing, so the daemon can load the
// same files the app does. The test reads the sources the app's prepare step wrote (a test run of
// the app leaves them under src/runtime/generated); without them it strips the plugins' TypeScript.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { HostAnswer, HostHandler, JsEngine, OK } from "@light/plugins/engine.ts";
import { done, eq, ok } from "@light/test/assert.ts";
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
  // The node stand-in for the engine's native calls, as the FFI manifest's node preload binds it.
  await import(["@light/plugins", "native", "wcjs-node.mjs"].join("/"));
  const generated = join("src", "runtime", "generated");
  const plugins = join("plugins");
  const sources: BuiltinSource[] = [];
  if (existsSync(generated)) {
    for (const name of readdirSync(generated).filter((n) => n.endsWith(".js.txt")).sort()) sources.push(new BuiltinSource(name, readFileSync(join(generated, name), "utf8")));
  } else {
    for (const name of readdirSync(plugins).sort()) {
      const path = name.endsWith(".ts") ? join(plugins, name) : join(plugins, name, "index.ts");
      if (existsSync(path)) sources.push(new BuiltinSource(name, stripTypeScriptTypes(readFileSync(path, "utf8")).replace(/^export \{\};\s*$/m, "")));
    }
  }
  const engine = new JsEngine(new Quiet(), 32, 1000);
  const built = engine.eval(EXT_PRELUDE, "harness:plugin-prelude");
  eq("the prelude evaluates", String(built.status), String(OK));
  let failed = "";
  for (const source of sources) {
    engine.eval("__extFile(" + JSON.stringify(source.name) + ")", "harness:plugin-file");
    const evaluated = engine.eval("(function () {\n" + source.code + "\n})();", source.name);
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
