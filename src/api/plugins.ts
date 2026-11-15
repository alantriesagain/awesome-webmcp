// The plugin API's `plugins` and `harness` calls, answered for the runtime (runtime.ts dispatches by
// namespace), for the harness plugin's tools: the plugins as the runtime holds them, a file
// reloaded, a source checked in a context of its own with nothing registered, the plugin guide and
// the API's types the binary carries (js/docs.ts, generated), and the project's harness folder.
import { PreludePart } from "@lightstart/plugins/prelude.ts";
import type { JsRuntime } from "../runtime/runtime.ts";
import { PLUGIN_GUIDE, PLUGIN_TYPES } from "../runtime/docs.ts";
import { HostAnswer, HostHandler, JsEngine, OK } from "@lightstart/plugins/engine.ts";
import { mergeColumns, mergePlugins } from "../services/harness.ts";
import { str, strs, json, answer, answerText, objectText, refuse, listText } from "./values.ts";

/** How a checked file's calls are answered: its registrations recorded, every other call refused (nothing runs). */
class CheckHandler extends HostHandler {
  readonly registered: string[] = [];

  override answer(name: string, args: string): HostAnswer {
    if (name === "plugin") {
      this.registered.push(args);
      return answer(null);
    }
    return refuse("widecode: " + name + " is not available while a file is checked");
  }
}

const GLOBAL_WRITE = /\bglobalThis\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\])\s*=[^=]/;
const CHECK_MEMORY_MB = 16;
const CHECK_BUDGET_MS = 250;

/** What checking a plugin source found: the ids it registers (with what each requires, as JSON object texts), its errors and warnings. */
export class SourceCheck {
  ids: string[] = [];
  plugins: string[] = [];
  errors: string[] = [];
  warnings: string[] = [];

  ok(): boolean {
    return this.errors.length === 0;
  }
}

/** Evaluate `code` (named `file`) in a context of its own, nothing registered: what it would define, its errors and warnings. */
export const checkSource = (rt: JsRuntime, code: string, file: string): SourceCheck => {
  const out = new SourceCheck();
  const handler = new CheckHandler();
  const engine = new JsEngine(handler, CHECK_MEMORY_MB, CHECK_BUDGET_MS);
  const prelude = engine.eval(rt.prelude, "widecode:prelude");
  if (prelude.status !== OK) out.errors.push("the plugin prelude: " + prelude.message());
  else {
    engine.eval("__file(" + JSON.stringify(file) + ")", "widecode:file");
    const r = engine.eval("(function () {\n" + code + "\n})();", file);
    if (r.status !== OK) out.errors.push(r.message());
  }
  engine.free();
  const known: string[] = [];
  for (const d of rt.defs) known.push(d.id);
  for (const p of rt.host.kernel.plugins) known.push(p.id);
  for (const reg of handler.registered) out.ids.push(str((JSON.parse(reg) as unknown[])[0]));
  for (const reg of handler.registered) {
    const v = JSON.parse(reg) as unknown[];
    const id = str(v[0]);
    const requires = strs(v[1]);
    out.plugins.push(objectText(["id", "requires"], [json(id), json(requires)]));
    for (const q of requires) if (!known.includes(q) && !out.ids.includes(q)) out.warnings.push(id + " requires " + q + ", which no plugin provides");
    for (const running of rt.plugins) if (running.id === id && running.file !== file) out.warnings.push(id + " would replace the running plugin " + id + " (" + running.file + ")");
  }
  if (out.errors.length === 0 && handler.registered.length === 0) out.errors.push("the file registers no plugin: call widecode.plugin({ id, activate(api) })");
  if (GLOBAL_WRITE.test(code)) out.warnings.push("a write to globalThis reaches every plugin and outlives a reload of the file");
  return out;
};

/** Plugin call `name` with its arguments `a`, answered; null for a call of another namespace. */
export const answerPlugins = (rt: JsRuntime, name: string, a: unknown[]): HostAnswer | null => {
  const h = rt.host;
  const k = h.kernel;
  switch (name) {
    case "plugins.list": {
      const out: string[] = [];
      for (const d of rt.defs) {
        const registered = rt.plugins.includes(d);
        let state = "stopped";
        let problem = d.problem;
        if (registered && k.has(d.id)) state = "running";
        else if (registered) {
          state = "failed";
          if (problem.length === 0) for (const p of k.problems) if (p.startsWith(d.id + ":")) problem = p.slice(d.id.length + 1).trim();
        } else if (k.settings.isOff(d.id)) state = "off";
        else if (rt.plugins.some((p) => p.id === d.id)) state = "replaced";
        out.push(objectText(["id", "file", "state", "problem"], [json(d.id), json(d.file), json(state), json(problem)]));
      }
      return answerText(objectText(["plugins", "errors"], [listText(out), json(rt.errors.slice(-30))]));
    }
    case "plugins.reload":
      return answer(rt.reloadPath(str(a[0])));
    case "plugins.check": {
      const c = checkSource(rt, str(a[0]), str(a[1]).length > 0 ? str(a[1]) : "check.js");
      return answerText(objectText(["ok", "plugins", "errors", "warnings"], [json(c.ok()), listText(c.plugins), json(c.errors), json(c.warnings)]));
    }
    case "plugins.api":
      return answerText(objectText(["guide", "types"], [json(PLUGIN_GUIDE), json(PLUGIN_TYPES)]));
    case "harness.init":
      return answer(h.harness.init());
    case "harness.info": {
      const hz = h.harness;
      const cfg = hz.config();
      const summary = hz.summary();
      const project = objectText(["plugins", "columns", "permissions"], [json(cfg.plugins), json(cfg.columns), json(cfg.permissions)]);
      const user = objectText(["plugins", "columns", "permissions"], [json(h.session.userPlugins), json(h.session.userColumns), json(h.session.userPermissions)]);
      const permissions = h.session.permissions();
      const effective = objectText(["plugins", "columns", "permissions", "notice"], [json(mergePlugins(h.session.userPlugins, cfg.plugins)), json(mergeColumns(h.session.userColumns, cfg.columns)), permissions.rulesJson(), json(permissions.notice)]);
      const config = objectText(["path", "present", "notice", "project", "user", "effective"], [json(hz.configPath()), json(summary.config), json(cfg.notice), project, user, effective]);
      const prompt = objectText(["path", "length"], [json(hz.promptPath()), String(hz.rawPrompt().length)]);
      const userPrompt = objectText(["path", "length"], [json(hz.userPromptPath), String(hz.userPrompt().length)]);
      return answerText(
        objectText(
          ["folder", "dir", "present", "trusted", "plugins", "prompt", "userPrompt", "config", "tools"],
          [json(h.workspace.folder), json(hz.dir()), json(hz.hasFolder()), json(hz.trusted), json(hz.pluginFiles()), prompt, userPrompt, config, json(rt.mcp.visibleNames(h.conversation.agent.owner))],
        ),
      );
    }
  }
  return null;
};

/** The `plugins` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_PLUGINS = new PreludePart("plugins", `        list: () => call("plugins.list"),
        reload: (file) => call("plugins.reload", String(file ?? "")),
        check: (code, file) => call("plugins.check", String(code), String(file ?? "")),
        api: () => call("plugins.api"),
`);

/** The `harness` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_HARNESS = new PreludePart("harness", `        info: () => call("harness.info"),
        init: () => call("harness.init"),
`);
