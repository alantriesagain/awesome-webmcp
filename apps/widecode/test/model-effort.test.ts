// ffi: @light/plugins/native/ffi.json
// The model and effort chosen are kept (plugins/models.ts), and an ACP agent's session starts with
// widecode (plugins/acp.ts), through the fake ACP agent and a store: the session made at the start,
// its model and efforts known before any message; /effort kept for the model, its provider and
// overall; /model kept as the agent's default; a model switched to gets the effort kept for it, else
// its provider's, else the last chosen, with config.json's efforts under those chosen; the next
// widecode starts on the model chosen last, with that effort; --model and --effort hold for their
// launch; a session made and never written to is deleted when it is left (/new, the next widecode,
// one whose widecode is gone), one written to is kept.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { Store } from "../src/services/store.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { Widecode, composeWidecode } from "../src/compose.ts";
import { done, eq, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

/** The string at `path` in a parsed value, "" when there is none. */
const field = (v: unknown, path: string[]): string => {
  let x = v;
  for (const k of path) {
    if (typeof x !== "object" || x === null || Array.isArray(x)) return "";
    x = (x as Record<string, unknown>)[k];
  }
  return typeof x === "string" ? x : "";
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-model-effort-"));
  const home = mkdtempSync(join(tmpdir(), "widecode-home-"));
  const log = join(folder, "fake.log");
  const forgotten = join(folder, "forgotten.txt");
  const fake = join(process.cwd(), "test/fake-acp.mjs");
  const ws = await openWorkspace(folder, 100);
  const config = (effort: unknown): unknown => {
    const models: unknown = effort === null ? { agents: { fake: ["fake/small", "fake/large"] } } : { agents: { fake: ["fake/small", "fake/large"] }, effort };
    return { models, acp: { agents: { fake: { name: "Fake", command: ["node", fake, "--log", log], forget: ["node", fake, "--forget", "{session}", "--forgotten", forgotten] } } } };
  };
  const sent = (): string => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const deleted = (): string => (existsSync(forgotten) ? readFileSync(forgotten, "utf8").trim().split("\n").filter((l: string) => l.length > 0).join(",") : "");
  /** What went to the agent as config options, in order ("effort=high model=fake/large"). */
  const options = (): string =>
    sent()
      .split("\n")
      .filter((l: string) => l.includes('"configId"'))
      .map((l: string) => {
        const m = /"configId":"(\w+)","value":"([^"]+)"/.exec(l);
        return m !== null ? m[1] + "=" + m[2] : "?";
      })
      .join(" ");
  const sessionsMade = (): number => sent().split('"method":"session/new"').length - 1;

  let store = new Store(home);
  let c = new Conversation(ws.folder);
  let w: Widecode = composeWidecode(ws, c);
  /** The models plugin's state, and the sessions the acp plugin made and has not written to. */
  const kept = (path: string[]): string => field(w.host.kernel.settings.state("models"), path);
  const fresh = (): string => {
    const v = w.host.kernel.settings.state("acp") as { fresh?: unknown } | null;
    const list = v !== null ? v.fresh : null;
    return Array.isArray(list) ? (list as unknown[]).map((x) => field(x, ["id"])).join(",") : "";
  };
  const said = (): string => w.host.screen.message.peek();
  const idle = (): boolean => !c.model.running && c.model.pending.length === 0;
  const turn = async (text: string): Promise<boolean> => {
    const before = c.model.turns.length;
    w.host.roles.chat.submit(text);
    return until(() => c.model.turns.length > before && idle());
  };
  const quit = (): void => {
    c.kill();
    w.host.kernel.stop();
    w.js.killProcesses();
  };

  w.host.session.agentId.value = "fake";
  w.start(config(null), store.stateFile(), []);
  c.prepare();
  await w.host.load();
  ok("the session starts with widecode: its model and efforts known before any message", (await until(() => c.info.modelId === "fake/small")) && c.started && c.agent.choices().efforts.map((e) => e.value).join(",") === "low,high,default" && sessionsMade() === 1 && !sent().includes('"method":"session/prompt"'));
  w.host.roles.chat.submit("/effort max");
  eq("/effort before any message knows the levels", said(), "effort is one of low, high, default (now default)");
  w.host.roles.chat.submit("/effort high");
  ok("one it has: switched", await until(() => c.info.effort === "high"));
  eq("kept for the model, its provider and overall", kept(["effort", "models", "fake/small"]) + " " + kept(["effort", "providers", "fake"]) + " " + kept(["effort", "default"]), "high high high");
  w.host.roles.chat.submit("/model large");
  ok("/model: switched, and kept as the agent's default", (await until(() => c.info.modelId === "fake/large")) && kept(["chosen", "fake"]) === "fake/large");
  ok("the effort kept for its provider follows (the agent starts a model on its own)", await until(() => c.info.effort === "high" && options() === "effort=high model=fake/large effort=high"));
  w.host.roles.chat.submit("/effort low");
  ok("kept for fake/large", (await until(() => c.info.effort === "low")) && kept(["effort", "models", "fake/large"]) + " " + kept(["effort", "models", "fake/small"]) + " " + kept(["effort", "providers", "fake"]) + " " + kept(["effort", "default"]) === "low high low low");
  w.host.roles.chat.submit("/model small");
  ok("back on fake/small: the effort kept for it follows", await until(() => c.info.modelId === "fake/small" && c.info.effort === "high"));
  w.host.roles.chat.submit("/model large");
  ok("fake/large again: its own", await until(() => c.info.modelId === "fake/large" && c.info.effort === "low"));
  eq("what went, in order", options(), "effort=high model=fake/large effort=high effort=low model=fake/small effort=high model=fake/large effort=low");

  // Nothing written to the session: /new deletes it and makes another, on the model chosen.
  eq("the session made and not written to is noted", fresh(), "fake-1");
  w.host.roles.chat.submit("/new");
  ok("/new: the session is deleted, another made on the model chosen, with its effort", await until(() => deleted() === "fake-1" && sessionsMade() === 2 && c.info.modelId === "fake/large" && c.info.effort === "low" && fresh() === "fake-2"));
  ok("a message: the session is written to", await turn("hello"));
  eq("no longer one to delete", fresh(), "");
  w.host.roles.chat.submit("/new");
  ok("/new keeps a session written to", (await until(() => sessionsMade() === 3)) && deleted() === "fake-1");
  ok("the new one on the model chosen", await until(() => c.info.modelId === "fake/large" && fresh() === "fake-3"));
  quit();
  eq("quit with one not written to: left for the next widecode", fresh(), "fake-3");

  // The next widecode: the model chosen last, the effort kept for it, the session left deleted.
  store = new Store(home);
  c = new Conversation(ws.folder);
  w = composeWidecode(ws, c);
  w.host.session.agentId.value = "fake";
  w.start(config(null), store.stateFile(), []);
  eq("the next widecode starts on the model chosen last", c.modelName, "fake/large");
  const made = sessionsMade();
  c.prepare();
  ok("its session on that model, with the effort kept for it, before any message", (await until(() => c.info.modelId === "fake/large" && c.info.effort === "low")) && sessionsMade() === made + 1 && sent().split('"method":"session/prompt"').length === 2);
  ok("the session the widecode before left is deleted", await until(() => deleted() === "fake-1,fake-3"));
  eq("this one noted in its place", fresh(), "fake-4");
  quit();

  // --model and --effort hold for their launch.
  store = new Store(home);
  c = new Conversation(ws.folder);
  c.modelName = "fake/small";
  c.effort = "default";
  w = composeWidecode(ws, c);
  w.host.session.agentId.value = "fake";
  w.start(config(null), store.stateFile(), []);
  eq("--model holds over the model chosen last", c.modelName, "fake/small");
  const before = options();
  c.prepare();
  ok("the session on it", await until(() => c.info.modelId === "fake/small"));
  await wait(150);
  eq("--effort holds over the effort kept for the model: nothing goes", options().slice(before.length).trim() + " " + c.info.effort, " default");
  quit();

  // config.json's efforts, under those chosen; a session left by a widecode that is gone.
  const home2 = mkdtempSync(join(tmpdir(), "widecode-home2-"));
  store = new Store(home2);
  store.stateFile().write(JSON.stringify({ acp: { fresh: [{ agent: "fake", id: "stale-1", pid: 999999, folder }] } }));
  c = new Conversation(ws.folder);
  w = composeWidecode(ws, c);
  w.host.session.agentId.value = "fake";
  w.start(config({ default: "low", providers: { fake: "high" }, models: { "fake/large": "low" } }), store.stateFile(), []);
  c.prepare();
  ok("config.json's effort for the provider, on the agent's own model", await until(() => c.info.modelId === "fake/small" && c.info.effort === "high"));
  ok("a session left by a widecode gone is deleted at the start", await until(() => deleted().endsWith("stale-1")));
  w.host.roles.chat.submit("/model large");
  ok("config.json's effort for the model comes before its provider's", await until(() => c.info.modelId === "fake/large" && c.info.effort === "low"));
  w.host.roles.chat.submit("/effort low");
  ok("chosen: kept for the model, its provider and overall", (await until(() => kept(["effort", "default"]) === "low")) && kept(["effort", "providers", "fake"]) === "low");
  w.host.roles.chat.submit("/model small");
  ok("the provider's chosen comes before config.json's for it", await until(() => c.info.modelId === "fake/small" && c.info.effort === "low"));
  quit();

  ws.close();
  rmSync(folder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(home2, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
