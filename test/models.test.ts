// ffi: @lightstart/plugins/native/ffi.json
// The models: aliases named in the status bar, the context window before the CLI reports one (the
// alias widecode starts with, the window stored for the session, the transcript's model, read by
// Claude Code's plugin), the
// config's model list, and F5 against the fake CLI: before a start it picks the model the CLI
// starts with (its arguments recorded by the fake), while it runs it sends `set_model` byte for
// byte; the session's record keeps the model and the window, and a resume starts with them; the
// model chosen is the default of the next widecode.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Widecode } from "../src/compose.ts";
import { Conversation } from "../src/conversation/conversation.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { modelName, StatusInfo } from "../src/conversation/status-info.ts";
import { Store } from "../src/services/store.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";

const fixtures = join(process.cwd(), "test", "fixtures");
const fake = join(process.cwd(), "test", "fake-claude.mjs");

const assistant = (model: string, parent: string): unknown => {
  const v: unknown = { type: "assistant", parent_tool_use_id: parent.length > 0 ? parent : null, message: { id: "m-" + model + parent, model, content: [], usage: { input_tokens: 10, cache_read_input_tokens: 158000, cache_creation_input_tokens: 290, output_tokens: 5 } } };
  return v;
};

eq("aliases and ids named", ["opus[1m]", "fable[1m]", "haiku", "claude-opus-5-5", "claude-fable-5-1[1m]"].map(modelName).join(", "), "Opus 1M, Fable 1M, Haiku, Opus 5.5, Fable 5.1 1M");

const key = (name: string): KeyEvent => new KeyEvent(name, "", false, false, false);

const waitIdle = (c: Conversation): Promise<boolean> =>
  new Promise((resolve) => {
    const started = Date.now();
    const check = (): void => {
      if (c.model.turns.length > 0 && !c.running) resolve(true);
      else if (Date.now() - started > 15000) resolve(false);
      else setTimeout(check, 20);
    };
    setTimeout(check, 20);
  });

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-models-"));
  const home = mkdtempSync(join(tmpdir(), "widecode-home-"));
  const argsFile = join(folder, "args.txt");
  const store = new Store(home);
  const written: string[] = [];
  const app = await openWidecode({
    folder,
    before: (app: Widecode) => {
      app.host.conversation.executable = fake;
      app.host.conversation.modelName = "opus[1m]";
      app.host.conversation.extraArgs.push("--fixture", join(fixtures, "edit.ndjson"), "--record-args", argsFile);
      app.host.conversation.onWrite = (line: string) => written.push(line);
    },
  });
  const conversation = app.host.conversation;
  await app.host.useStore(store);

  app.shell.handleKey(key("f5"));
  eq("F5 before a start: the next model, named by its alias", conversation.modelName + " " + conversation.info.modelLabel + " " + String(conversation.info.windowSize), "fable[1m] Fable 1M 1000000");
  eq("nothing sent to a CLI that is not running", String(written.length), "0");
  eq("the message is sent", conversation.send("go", []), "");
  ok("the turn ends", await waitIdle(conversation));
  const args = readFileSync(argsFile, "utf8").split("\n");
  const at = args.indexOf("--model");
  eq("the CLI started with the chosen model", at >= 0 ? args[at + 1] : "(none)", "fable[1m]");
  const id = conversation.sessionId;
  const records = app.host.session.records;
  if (records !== null) await records.settled();
  const meta = records !== null ? records.session(id, folder) : null;
  eq("the session's record: its model and the reported window", meta !== null ? meta.model + " " + String(meta.contextWindow) : "(none)", "fable[1m] 200000");

  app.shell.handleKey(key("f5"));
  eq("F5 while it runs: set_model, byte for byte", written[written.length - 1], '{"type":"control_request","request_id":"code-1","request":{"subtype":"set_model","model":"opus[1m]"}}');
  if (records !== null) await records.settled();
  const after = records !== null ? records.session(id, folder) : null;
  eq("the record follows the switch", after !== null ? after.model + " " + String(after.contextWindow) : "(none)", "opus[1m] 0");
  closeWidecode(app);

  // The models plugin's list from config.json: its first for a new session, F5 through the rest.
  const listed = async (config: string): Promise<string> => {
    const w = await openWidecode({ folder, plugins: JSON.parse(config) });
    const c = w.host.conversation;
    const seen = [c.modelName];
    for (let i = 0; i < 2; i++) {
      w.shell.handleKey(key("f5"));
      seen.push(c.modelName);
    }
    closeWidecode(w);
    return seen.join(" ");
  };
  eq("the default models", await listed("{}"), "opus[1m] fable[1m] opus[1m]");
  eq("the config's models, names trimmed, the rest left out", await listed('{"models": {"list": ["sonnet", " haiku ", 3, ""]}}'), "sonnet haiku sonnet");
  eq("an empty list keeps the defaults", await listed('{"models": {"list": []}}'), "opus[1m] fable[1m] opus[1m]");

  // The model chosen (F5, /model) is the agent's default for the next widecode; --model comes before it.
  const keptHome = mkdtempSync(join(tmpdir(), "widecode-home-"));
  const chooserApp = await openWidecode({ folder, state: new Store(keptHome).stateFile() });
  const chooser = chooserApp.host.conversation;
  chooserApp.shell.handleKey(key("f5"));
  eq("F5 before a start, kept", chooser.modelName, "fable[1m]");
  closeWidecode(chooserApp);
  const nextApp = await openWidecode({ folder, state: new Store(keptHome).stateFile() });
  const next = nextApp.host.conversation;
  eq("the next widecode starts on the model chosen last", next.modelName, "fable[1m]");
  closeWidecode(nextApp);
  const flaggedApp = await openWidecode({
    folder,
    state: new Store(keptHome).stateFile(),
    before: (app: Widecode) => {
      app.host.conversation.modelName = "haiku";
    },
  });
  const flagged = flaggedApp.host.conversation;
  eq("--model comes before it", flagged.modelName, "haiku");
  closeWidecode(flaggedApp);
  rmSync(keptHome, { recursive: true, force: true });

  // A later widecode resumes the session on the model it last ran on.
  const laterConfig: unknown = { claude: { projects: join(folder, ".projects") } };
  const laterApp = await openWidecode({ folder, plugins: laterConfig });
  const later = laterApp.host.conversation;
  await laterApp.host.useStore(new Store(home));
  later.modelName = "fable[1m]";
  later.resume(id, "");
  eq("a resume starts with the session's model", later.modelName + " " + later.info.modelLabel + " " + String(later.info.windowSize), "opus[1m] Opus 1M 1000000");
  closeWidecode(laterApp);
  // A resumed session: the transcript names claude-opus-5-5 (no "[1m]"), widecode starts it with opus[1m].
  const sw = await openWidecode({ folder });
  const s = sw.host.conversation;
  /** The status after `records`, received by Claude Code's plugin, the session started on `alias`. */
  const status = (alias: string, records: unknown[]): StatusInfo => {
    s.modelName = alias;
    s.reset();
    for (const r of records) s.receive(JSON.stringify(r));
    return s.info;
  };
  const resumed = status("opus[1m]", [assistant("claude-opus-5-5", "")]);
  eq("the transcript's model and the alias's window", resumed.modelId + " " + String(resumed.windowSize) + " " + resumed.modelLabel, "claude-opus-5-5 1000000 Opus 5.5 1M");
  eq("158k of 1M", String(Math.round((resumed.contextUsed / resumed.windowSize) * 100)) + "%", "16%");
  s.receive(JSON.stringify(assistant("claude-haiku-4-5-20251001", "toolu_1")));
  eq("a subagent's model is not the session's", resumed.modelId, "claude-opus-5-5");
  const plain = status("", [assistant("claude-opus-5-5", "")]);
  eq("without an alias or a stored window: 200k", String(plain.windowSize), "200000");
  plain.knownWindow = 1000000;
  eq("the stored window wins over the guess", String(plain.windowSize), "1000000");
  plain.contextSize = 500000;
  eq("and the reported one over the stored", String(plain.windowSize), "500000");
  const before = new StatusInfo();
  before.modelHint = "fable[1m]";
  eq("before any record: the alias's name", before.modelLabel, "Fable 1M");
  closeWidecode(sw);
  rmSync(folder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
