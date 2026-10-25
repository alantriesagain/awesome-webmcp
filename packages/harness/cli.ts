// `widecode --harness [--log <file>] [--harness-fake <fixture>]`: the harness as a process speaking
// ACP on stdin and stdout, over the store (`~/.widecode`) whose config.json has its section and
// whose auth.json has the keys. Its log is a file of its own under the store's `harness/logs`;
// stdin's end and SIGTERM end it. The side commands the ACP entry names are answered by the same
// program without starting the loop: `--harness-tools <mode>` (the tools of a mode, in opencode's
// listing shape), `--harness-skills`, `--harness-sessions` (the folder's sessions, as JSON),
// `--harness-forget <id>` (its file removed); and for the user, `--harness-models` (the models offered and which
// providers have a key) and `--harness-auth <provider>` (a key read from stdin into auth.json).
import { join } from "node:path";
import { log, nameLog, openLogIn } from "@light/lib/log.ts";
import { errorMessage } from "@light/lib/json.ts";
import { AcpAgent } from "./acp/agent.ts";
import { AcpServer, Incoming } from "./acp/server.ts";
import { Auth } from "./auth.ts";
import { HarnessConfig } from "./config.ts";
import { ModelClient } from "./model/client.ts";
import { FakeClient } from "./model/fake.ts";
import { ModelInfo, ModelRegistry, NO_THINKING, Provider } from "./model/registry.ts";
import { HarnessPaths } from "./paths.ts";
import { scanSkills, skillsJson } from "./prompt/skills.ts";
import { SessionStore, sessionsJson } from "./session/store.ts";
import { ToolSet, builtInTools } from "./tools/tool.ts";

const argValue = (args: string[], name: string): string | null => {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : null;
};

/** The tools of a mode, every one on, as opencode's `debug agent` prints them; plan mode has the read-only ones. */
export const toolsListing = (mode: string): string => {
  const names = new ToolSet(builtInTools()).forMode(mode).tools.map((t) => t.name);
  return '{"tools":{' + names.map((n) => JSON.stringify(n) + ":true").join(",") + '},"permission":[]}';
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
export const harnessMain = (storeRoot: string, args: string[], build: string): Promise<number> => {
  const done = (code: number): Promise<number> => new Promise<number>((settle) => settle(code));
  const paths = new HarnessPaths(storeRoot);
  const tools = argValue(args, "--harness-tools");
  if (tools !== null) {
    process.stdout.write(toolsListing(tools) + "\n");
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
    for (const p of r.providers) {
      const key = auth.keyFor(p);
      process.stdout.write(p.name + " (" + p.id + "): " + (key.length > 0 ? "key set" : "no key: set " + p.keyEnv + " or run widecode --harness-auth " + p.id) + "\n");
      for (const m of r.models) if (m.provider === p.id) process.stdout.write("  " + m.modelValue() + "  " + m.name + "\n");
    }
    return done(0);
  }
  const authFor = argValue(args, "--harness-auth");
  if (authFor !== null) {
    const r = registryFor(config, false);
    if (r.provider(authFor) === null) {
      process.stderr.write("no provider " + authFor + "; one of " + r.providers.map((p) => p.id).join(", ") + "\n");
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
    nameLog("widecode-harness");
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
    const agent = new AcpAgent(server, client, new ToolSet(builtInTools()), registry, config, build, process.platform, paths);
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
      settle(0);
    };
    server.onStdinEnd = () => end("stdin ended: stopping");
    process.on("SIGTERM", () => end("signal SIGTERM"));
    process.on("SIGINT", () => end("signal SIGINT"));
    server.listen();
    log("listening on stdio" + (fixture !== null ? ", the fake model from " + fixture : "") + "; the store " + storeRoot + "; models " + registry.models.map((m) => m.modelValue()).join(", ") + "; http " + config.http);
  });
};

export { join };
