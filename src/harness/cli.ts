// `lightcode --harness [--log <file>] [--harness-fake <fixture>]`: the harness as a process speaking
// ACP on stdin and stdout, over the store (`~/.lightcode`) whose config.json has its section and
// whose auth.json has the keys. Its log is a file of its own under the store's `harness/logs`;
// stdin's end and SIGTERM end it. The side commands the ACP entry names are answered by the same
// program without starting the loop: `--harness-tools <mode>` (the tools of a mode, in opencode's
// listing shape), `--harness-skills`, `--harness-sessions` (the folder's sessions, as JSON),
// `--harness-forget <id>` (its file removed); and for the user, `--harness-models` (the models offered and which
// providers have a key) and `--harness-auth <provider>` (a key read from stdin into auth.json).
import { join } from "node:path";
import { log, nameLog, openLogIn } from "@lightstart/lib/log.ts";
import { readTextOr } from "@lightstart/lib/fs.ts";
import { errorMessage, listOf, parseJson, recordOf, str } from "@lightstart/lib/json.ts";
import { AcpAgent } from "./acp/agent.ts";
import { AcpServer, Incoming } from "./acp/server.ts";
import { Auth } from "./auth.ts";
import { HarnessConfig } from "./config.ts";
import { ModelClient } from "./model/client.ts";
import { FakeClient } from "./model/fake.ts";
import { ModelInfo, ModelRegistry, NO_THINKING, Provider } from "./model/registry.ts";
import { HarnessPaths } from "./paths.ts";
import { scanSkills, skillsJson } from "./prompt/skills.ts";
import { findBrowser } from "./tools/browser.ts";
import { DenyRule, listingRules, parseRules, rulesIn } from "./tools/permissions.ts";
import { Fetched, WebSettings, httpText, searchOrder } from "./tools/web.ts";
import { Abort } from "./loop/abort.ts";
import { SessionStore, sessionsJson } from "./session/store.ts";
import { ToolSet, builtInTools } from "./tools/tool.ts";
import { ExtensionsRegistry } from "./ext/extensions.ts";
import { PluginSource } from "@lightstart/plugins/sources.ts";

const argValue = (args: string[], name: string): string | null => {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : null;
};

/** The tools of a mode, every one on, as opencode's `debug agent` prints them, plan mode's the read-only ones; a tool the deny rules refuse whole marked so. `extra` are the names extensions registered. */
export const toolsListing = (mode: string, rules: DenyRule[], extra: string[] = []): string => {
  const names = new ToolSet(builtInTools()).forMode(mode).tools.map((t) => t.name);
  for (const name of extra) if (!names.includes(name)) names.push(name);
  return '{"tools":{' + names.map((n) => JSON.stringify(n) + ":true").join(",") + '},"permission":' + listingRules(rules) + "}";
};

/** Whether the store's `trusted.json` lists `folder` (the app's trust, which the ACP client otherwise passes per session). */
const folderTrusted = (paths: HarnessPaths, folder: string): boolean => {
  try {
    const list = parseJson(readTextOr(join(paths.storeRoot, "trusted.json"), ""));
    for (const v of listOf(list)) if (v === folder) return true;
  } catch {
    return false;
  }
  return false;
};

/** The search APIs a key is kept for, beside the model providers. */
const SEARCH_KEYS = ["brave", "tavily", "exa"];

/** What the web tools have on this machine: the browser found, the search backends with their settings and keys. */
export const webSettings = (config: HarnessConfig, auth: Auth, paths: HarnessPaths): WebSettings => {
  const w = new WebSettings();
  w.browser = findBrowser(config.browserCommand, paths.userHome);
  w.profileRoot = join(paths.root(), "browser");
  w.httpKind = config.http;
  w.searxng = config.searxng;
  w.braveKey = auth.keyFor(new Provider("brave", "Brave Search", "", "BRAVE_API_KEY", false));
  w.tavilyKey = auth.keyFor(new Provider("tavily", "Tavily", "", "TAVILY_API_KEY", false));
  w.exaKey = auth.keyFor(new Provider("exa", "Exa", "", "EXA_API_KEY", false));
  w.order = searchOrder(config.searchOrder, w);
  return w;
};

/** Whether `args` ask for the harness or one of its side commands. */
export const isHarnessArgs = (args: string[]): boolean => args.some((a) => a === "--harness" || a.startsWith("--harness-"));

/** The registry a run offers: the built-in providers, the config's, and the fake when a fixture is given. */
export const registryFor = (config: HarnessConfig, fake: boolean): ModelRegistry => {
  const r = ModelRegistry.builtIn();
  config.addProviders(r);
  if (fake) {
    r.providers.unshift(new Provider("fake", "Fake", "", "", true));
    const m = new ModelInfo("fake", "fake", "Fake");
    m.thinking = NO_THINKING;
    m.efforts = ["low", "medium", "high"];
    r.models.unshift(m);
  }
  return r;
};

/** A line from stdin, for a key typed or piped. */
const readLine = (): Promise<string> =>
  new Promise<string>((settle) => {
    let text = "";
    const decoder = new TextDecoder();
    process.stdin.on("data", (chunk: Uint8Array) => {
      text += decoder.decode(chunk, { stream: true });
      const at = text.indexOf("\n");
      if (at >= 0) settle(text.slice(0, at));
    });
    process.stdin.on("end", () => settle(text));
  });

/** Run what `args` ask for over the store at `storeRoot`; settles with the exit code. */
export const harnessMain = (storeRoot: string, args: string[], build: string, builtins: PluginSource[] = []): Promise<number> => {
  const done = (code: number): Promise<number> => new Promise<number>((settle) => settle(code));
  const paths = new HarnessPaths(storeRoot);
  const tools = argValue(args, "--harness-tools");
  if (tools !== null) {
    // In the folder the command runs in: the user's rules and the project's, and the tools its extensions register.
    const cwd = process.cwd();
    const rules = parseRules(rulesIn(paths.configPath()).concat(rulesIn(join(cwd, ".lightcode", "config.json"))));
    const extensions = new ExtensionsRegistry(paths, null, builtins).forSession(cwd, folderTrusted(paths, cwd)).instance("", cwd);
    process.stdout.write(toolsListing(tools, rules, extensions.tools().map((t) => t.name)) + "\n");
    return done(0);
  }
  paths.userHome = process.env["HOME"] ?? "";
  // The skills of the folder the command runs in (`cd <folder> && ...`), the user's and the harness's.
  if (args.includes("--harness-skills")) {
    process.stdout.write(skillsJson(scanSkills(process.cwd(), true, paths.userHome, paths.root())) + "\n");
    return done(0);
  }
  // The sessions side commands run in the folder (`cd <folder> && ...`), whose sessions they mean.
  if (args.includes("--harness-sessions")) {
    const cwd = process.cwd();
    process.stdout.write(sessionsJson(new SessionStore(paths.sessionsDir(cwd)).list(cwd)) + "\n");
    return done(0);
  }
  const forget = argValue(args, "--harness-forget");
  if (forget !== null) {
    new SessionStore(paths.sessionsDir(process.cwd())).remove(forget);
    return done(0);
  }
  const config = HarnessConfig.read(paths.configPath());
  const auth = new Auth(paths.authPath());
  if (args.includes("--harness-models")) {
    const r = registryFor(config, false);
    const zen = r.provider("opencode");
    const zenKey = zen !== null ? auth.keyFor(zen) : "";
    // Zen answers its list with the models the key has enabled; another is refused ("Model access is disabled").
    const enabled = zenKey.length > 0 ? httpText("GET", "https://opencode.ai/inference/v1/models", [["authorization", "Bearer " + zenKey]], "", config.http, new Abort()) : null;
    const listing = enabled !== null ? enabled : new Promise<Fetched>((settle) => settle(new Fetched()));
    return listing.then((got: Fetched) => {
      const ids = new Set<string>();
      if (got.status === 200) for (const v of listOf(recordOf(parseJson(got.body))?.["data"])) ids.add(str(recordOf(v)?.["id"]));
      for (const p of r.providers) {
        const key = auth.keyFor(p);
        process.stdout.write(p.name + " (" + p.id + "): " + (key.length > 0 ? "key set" : "no key: set " + p.keyEnv + " or run lightcode --harness-auth " + p.id) + "\n");
        for (const m of r.models) {
          if (m.provider !== p.id) continue;
          const note = p.id === "opencode" && ids.size > 0 && !ids.has(m.id) ? "  (not enabled for this key)" : "";
          process.stdout.write("  " + m.modelValue() + "  " + m.name + note + "\n");
        }
        if (p.id === "opencode" && key.length > 0 && got.status !== 200) process.stdout.write("  (the list of models the key has could not be read" + (got.error.length > 0 ? ": " + got.error : "") + ")\n");
      }
      return 0;
    });
  }
  const authFor = argValue(args, "--harness-auth");
  if (authFor !== null) {
    const r = registryFor(config, false);
    if (r.provider(authFor) === null && !SEARCH_KEYS.includes(authFor)) {
      process.stderr.write("no provider " + authFor + "; one of " + r.providers.map((p) => p.id).concat(SEARCH_KEYS).join(", ") + "\n");
      return done(2);
    }
    process.stderr.write("the key for " + authFor + " (not shown as you type it): ");
    return readLine().then((line: string) => {
      const key = line.trim();
      if (key.length === 0) {
        process.stderr.write("\nno key given\n");
        return 2;
      }
      auth.writeKey(authFor, key);
      process.stderr.write("\nkept in " + paths.authPath() + "\n");
      return 0;
    });
  }
  return new Promise<number>((settle) => {
    nameLog("lightcode-harness");
    openLogIn(paths.logsDir(), 10);
    log(build + " harness");
    process.on("uncaughtExceptionMonitor", (err: Error, origin: string) => {
      log((origin === "unhandledRejection" ? "unhandled rejection: " : "uncaught exception: ") + (err instanceof Error ? err.name + ": " + err.message : String(err)));
    });
    const fixture = argValue(args, "--harness-fake");
    const registry = registryFor(config, fixture !== null);
    const fake = fixture !== null ? FakeClient.fromFile(fixture) : null;
    // The model a session starts on: the config's, else the fake's with a fixture, else the first whose provider has a key.
    if (registry.model(config.model) === null) {
      config.model = "";
      if (fixture !== null) config.model = "fake/fake";
      else
        for (const m of registry.models) {
          const p = registry.provider(m.provider);
          if (p !== null && auth.keyFor(p).length > 0) {
            config.model = m.modelValue();
            break;
          }
        }
    }
    const client = new ModelClient(registry, auth, config.http, fake);
    const server = new AcpServer();
    server.tracePath = argValue(args, "--log") ?? "";
    const agent = new AcpAgent(server, client, new ToolSet(builtInTools()), registry, config, build, process.platform, paths, builtins);
    agent.web = webSettings(config, auth, paths);
    log("the web: " + (agent.web.browser.length > 0 ? "the browser " + agent.web.browser : "no browser, curl") + "; search " + (agent.web.order.length > 0 ? agent.web.order.join(", ") : "none"));
    server.onIncoming = (m: Incoming) => {
      try {
        agent.receive(m);
      } catch (err) {
        log("error on " + m.method + ": " + errorMessage(err, "error"));
        if (m.idText.length > 0) server.refuse(m.idText, -32603, errorMessage(err, "the request failed"));
      }
    };
    let ended = false;
    const end = (why: string): void => {
      if (ended) return;
      ended = true;
      log(why);
      agent.shutdown().then(
        () => settle(0),
        () => settle(0),
      );
    };
    server.onStdinEnd = () => end("stdin ended: stopping");
    process.on("SIGTERM", () => end("signal SIGTERM"));
    process.on("SIGINT", () => end("signal SIGINT"));
    server.listen();
    log("listening on stdio" + (fixture !== null ? ", the fake model from " + fixture : "") + "; the store " + storeRoot + "; models " + registry.models.map((m) => m.modelValue()).join(", ") + "; http " + config.http);
  });
};

export { join };
