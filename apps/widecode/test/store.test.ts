// ffi: @light/plugins/native/ffi.json
// widecode's store and titles, in a temporary WIDECODE_HOME: the config written with the plugins'
// defaults and the log's on first run and read back, its "log" in each of its shapes, one from
// before plugins moved under "plugins" once, a
// broken one falling back with a notice; a project's .widecode/ ignoring itself; the limits round
// trip and the ~/.ctui migration (its records read by the folder's records, test/session-records.test.ts
// for the records themselves); a session's cost added up across CLI processes by Claude Code's plugin; titles from a
// stand-in CLI (cleaned, asked once, asked again on demand, the right flags); a finished first turn
// asking for and storing its session's title; the order in which titles are shown.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { Limits } from "@widecode/conversation/session-store.ts";
import { SessionRecords } from "../src/services/sessions.ts";
import { PluginDefault, Store } from "../src/services/store.ts";
import { Hook } from "@light/lib/hook.ts";
import { cleanTitle, shownTitle, Titler } from "@widecode/agent/titles.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { createWidecode } from "../src/compose.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const home = mkdtempSync(join(tmpdir(), "widecode-home-"));
const stub = join(process.cwd(), "test", "fake-title.sh");
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const main = async (): Promise<void> => {
  const store = new Store(home);
  const sessionDefaults: unknown = { titles: true, titleModel: "haiku" };
  const defaults = [new PluginDefault("chat", true), new PluginDefault("sessions", sessionDefaults)];
  const c = store.loadConfig(defaults);
  ok("config.json written on first run", existsSync(join(home, "config.json")));
  const written = readFileSync(join(home, "config.json"), "utf8");
  eq("every plugin listed under plugins, with its defaults; the clipboard's way; the log on", written, '{\n  "clipboard": "auto",\n  "log": { "enabled": true, "keep": 30 },\n  "plugins": {\n    "chat": true,\n    "sessions": {\n      "titles": true,\n      "titleModel": "haiku"\n    }\n  }\n}\n');
  const section = (config: unknown, id: string): string => JSON.stringify((config as Record<string, unknown>)[id]);
  eq("and handed to the kernel as read", section(c.plugins, "sessions") + " " + c.notice, '{"titles":true,"titleModel":"haiku"} ');
  const again = new Store(home).loadConfig(defaults);
  eq("read back as written", section(again.plugins, "chat") + section(again.plugins, "sessions") + " " + again.clipboard, 'true{"titles":true,"titleModel":"haiku"} auto');
  writeFileSync(join(home, "config.json"), readFileSync(join(home, "config.json"), "utf8").replace('"auto"', '"osc52"'));
  eq("the clipboard's way as set", new Store(home).loadConfig(defaults).clipboard, "osc52");
  writeFileSync(join(home, "config.json"), readFileSync(join(home, "config.json"), "utf8").replace('"clipboard"', '"keymap": "vi",\n  "clipboard"'));
  eq("the keymap as set", new Store(home).loadConfig(defaults).keymap, "vi");
  const logOf = (value: string): string => {
    const text = readFileSync(join(home, "config.json"), "utf8");
    const at = text.indexOf('"log": ');
    const end = text.indexOf("\n", at);
    writeFileSync(join(home, "config.json"), text.slice(0, at) + '"log": ' + value + "," + text.slice(end));
    const l = new Store(home).loadConfig(defaults).log;
    return String(l.enabled) + " " + JSON.stringify(l.dir) + " " + String(l.keep);
  };
  eq("the log as written on first run: on, the store's folder, 30 kept", logOf('{ "enabled": true, "keep": 30 }'), 'true "" 30');
  eq("false turns it off", logOf("false"), 'false "" 30');
  eq("true, on", logOf("true"), 'true "" 30');
  eq("a folder and how many runs to keep", logOf('{ "dir": " ~/logs ", "keep": 5.7 }'), 'true "~/logs" 5');
  eq("what is not of its type is left at its default", logOf('{ "enabled": "no", "dir": 3, "keep": 0 }'), 'true "" 30');
  eq("no keys.json: no text", new Store(home).readKeys(), "");
  writeFileSync(join(home, "keys.json"), '{ "": { "f5": null } }\n');
  eq("keys.json read as text", new Store(home).readKeys(), '{ "": { "f5": null } }\n');

  const before = mkdtempSync(join(tmpdir(), "widecode-before-"));
  writeFileSync(join(before, "config.json"), '{"titles":{"auto":false},"models":["sonnet"],"statusline":{"separator":" · ","lines":[["model"]]},"plugins":{"git":false}}');
  const movedConfig = new Store(before).loadConfig(defaults);
  eq("a config from before plugins: its keys moved under plugins, once", section(movedConfig.plugins, "git") + " " + section(movedConfig.plugins, "sessions") + " " + section(movedConfig.plugins, "models") + " " + section(movedConfig.plugins, "status") + " | " + String(movedConfig.notice.includes("moved")), 'false {"titles":false,"titleModel":"haiku"} {"list":["sonnet"]} {"separator":" · ","lines":[["model"]]} | true');
  const settled = new Store(before).loadConfig(defaults);
  ok("the file now holds only plugins, and moves nothing again", !readFileSync(join(before, "config.json"), "utf8").includes('"statusline"') && settled.notice === "" && section(settled.plugins, "models") === '{"list":["sonnet"]}');
  rmSync(before, { recursive: true, force: true });
  writeFileSync(join(home, "config.json"), "{nope");
  const broken = new Store(home).loadConfig(defaults);
  ok("a broken config: every plugin on with its defaults, and a notice", broken.plugins === null && broken.notice.startsWith("config.json is not valid JSON"));

  const project = mkdtempSync(join(tmpdir(), "widecode-project-"));
  store.ignoreIn(project, true);
  ok("a project's .widecode/ ignores itself in git", readFileSync(join(project, ".widecode", ".gitignore"), "utf8").endsWith("\n*\n"));
  const earlier = mkdtempSync(join(tmpdir(), "widecode-earlier-"));
  mkdirSync(join(earlier, ".widecode", "sessions"), { recursive: true });
  const bare = mkdtempSync(join(tmpdir(), "widecode-bare-"));
  store.ignoreIn(earlier, false);
  store.ignoreIn(bare, false);
  ok("an earlier .widecode/ gets it when its folder opens; a folder without one is left alone", existsSync(join(earlier, ".widecode", ".gitignore")) && !existsSync(join(bare, ".widecode")));
  rmSync(earlier, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });

  // An earlier version's ~/.ctui: config and limits move to the store, records into their projects.
  const old = mkdtempSync(join(tmpdir(), "ctui-old-"));
  mkdirSync(join(old, "sessions"), { recursive: true });
  writeFileSync(join(old, "config.json"), '{"titles":{"auto":false},"clipboard":"osc52","columns":{"chat":40},"permissions":{"ask":["Bash(rm *)"]},"agent":"opencode","keymap":"vi"}');
  writeFileSync(join(old, "limits.json"), '{"fiveHour":{"usedPercent":12,"resetsAt":5}}');
  writeFileSync(join(old, "sessions", "old-1.json"), JSON.stringify({ id: "old-1", folder: project, title: "From ctui", titleBy: "claude" }));
  writeFileSync(join(old, "sessions", "gone.json"), JSON.stringify({ id: "gone", folder: "/no/such/folder", title: "x" }));
  const fresh = mkdtempSync(join(tmpdir(), "widecode-fresh-"));
  const migrated = new Store(fresh).migrateFrom(old);
  eq("the migration says what it did, and what stayed", migrated, "moved " + old + " to " + fresh + " and 1 session records into their projects; 1 record stayed in " + old);
  const after = new Store(fresh);
  const afterConfig = after.loadConfig([]).plugins as { sessions?: { titles?: unknown } } | null;
  ok("its config and limits came along", afterConfig !== null && afterConfig.sessions !== undefined && afterConfig.sessions.titles === false && after.limits().fiveHour.usedPercent === 12);
  eq("a flat limits file is Claude Code's, not another agent's", String(after.limits("opencode").fiveHour.usedPercent), "-1");
  const kept = JSON.parse(readFileSync(join(fresh, "config.json"), "utf8")) as { clipboard?: unknown; columns?: unknown; permissions?: unknown; agent?: unknown; keymap?: unknown };
  ok("the migration keeps the keys it did not move", kept.clipboard === "osc52" && JSON.stringify(kept.columns) === '{"chat":40}' && JSON.stringify(kept.permissions) === '{"ask":["Bash(rm *)"]}' && kept.agent === "opencode" && kept.keymap === "vi");
  const afterRecords = new SessionRecords(after, new Hook());
  await afterRecords.open(project);
  const moved = afterRecords.session("old-1", project);
  ok("a record moved into its project, read by the folder's records", moved !== null && moved.title === "From ctui");
  await afterRecords.close();
  ok("the old folder stays with the record it could not move", existsSync(old) && existsSync(join(old, "sessions", "gone.json")));
  eq("a second run does nothing", new Store(fresh).migrateFrom(old), "");
  const movedOther = new Limits();
  movedOther.fiveHour.usedPercent = 7;
  after.saveLimits(movedOther, "opencode");
  const reread = new Store(fresh);
  eq("a flat file's windows stay Claude's as another agent's are added", String(reread.limits().fiveHour.usedPercent) + " " + String(reread.limits("opencode").fiveHour.usedPercent), "12 7");
  rmSync(fresh, { recursive: true, force: true });

  ok("a task transcript round trips under the project", store.saveTaskTranscript(project, "s-1", "task-2", "{\"type\":\"text\"}\n") && store.taskTranscript(project, "s-1", "task-2") === "{\"type\":\"text\"}\n");

  const l = new Limits();
  l.fiveHour.usedPercent = 4;
  l.fiveHour.resetsAt = 1791939600;
  l.sevenDay.usedPercent = 39;
  store.saveLimits(l);
  const lb = new Store(home).limits();
  eq("limits round trip", String(lb.fiveHour.usedPercent) + "/" + String(lb.fiveHour.resetsAt) + " " + String(lb.sevenDay.usedPercent), "4/1791939600 39");
  const other = new Limits();
  other.fiveHour.usedPercent = 77;
  other.fiveHour.resetsAt = 1791939900;
  other.sevenDay.usedPercent = 12;
  store.saveLimits(other, "opencode");
  const oc = new Store(home).limits("opencode");
  const cc = new Store(home).limits("claude");
  eq("an agent's limits are its own; another's are kept", String(oc.fiveHour.usedPercent) + "/" + String(oc.sevenDay.usedPercent) + " " + String(cc.fiveHour.usedPercent) + "/" + String(cc.fiveHour.resetsAt), "77/12 4/1791939600");

  eq("a title cleaned", cleanTitle('\n**Title:** "Rename the helper."\nmore'), "Rename the helper");
  eq("titles shown in order: widecode's, Claude Code's, the first prompt", [shownTitle("Mine", "Claude's", "prompt"), shownTitle("", "Claude's", "prompt"), shownTitle("", "", "a very long first prompt that goes on and on past fifty characters")].join(" | "), "Mine | Claude's | a very long first prompt that goes on and on past…");

  const argsFile = join(home, "title-args.txt");
  process.env["TITLE_ARGS"] = argsFile;
  const titler = new Titler();
  titler.executable = stub;
  const got: string[] = [];
  titler.onTitle = (id: string, title: string) => got.push(id + "=" + title);
  ok("a request is queued", titler.request("s-2", "Please rename the helper function", "Sure, renaming.", false));
  ok("asked once", !titler.request("s-2", "again", "", false));
  await wait(1500);
  eq("the stand-in's answer, cleaned", got.join(","), "s-2=Rename the helper");
  const args = readFileSync(argsFile, "utf8").split("\n");
  ok("a cheap call: -p, haiku, low effort, nothing saved, no tools", args.includes("-p") && args.join(" ").includes("--model haiku --effort low --no-session-persistence --tools  --system-prompt"));
  ok("with the first prompt and the reply", readFileSync(argsFile, "utf8").includes("Please rename the helper function") && readFileSync(argsFile, "utf8").includes("Sure, renaming."));
  ok("asked again on demand", titler.request("s-2", "again", "", true));
  titler.enabled = false;
  ok("nothing when titles are off", !titler.request("s-3", "x", "", false));
  await wait(1500);

  // A conversation's turns: cost across processes, the first turn's title.
  const repo = mkdtempSync(join(tmpdir(), "widecode-repo-"));
  const ws = await openWorkspace(repo, 100);
  const conv = new Conversation(ws.folder);
  // Claude Code's plugin reads the records and keeps the session's record; the CLI ran on its own default model.
  const app = createWidecode(ws, conv, null);
  await app.host.useStore(store);
  conv.modelName = "";
  const t2 = app.host.session.titler;
  t2.executable = stub;
  const titles: string[] = [];
  t2.onTitle = (id: string, title: string) => titles.push(id + "=" + title);
  conv.model.send("Fix the flaky test", 0);
  conv.receive('{"type":"system","subtype":"init","session_id":"s-9","model":"claude-haiku-4-5"}');
  conv.receive('{"type":"user","isReplay":true,"message":{"role":"user","content":"Fix the flaky test"}}');
  conv.receive('{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Looking at the test."}]}}');
  conv.receive('{"type":"result","subtype":"success","total_cost_usd":0.01,"usage":{"output_tokens_details":{"thinking_tokens":40}}}');
  conv.receive('{"type":"result","subtype":"success","total_cost_usd":0.03,"usage":{"output_tokens_details":{"thinking_tokens":10}}}');
  conv.receive('{"type":"result","subtype":"success","total_cost_usd":0.02}');
  const repoRecords = app.host.session.records;
  if (repoRecords !== null) await repoRecords.settled();
  const s9 = repoRecords !== null ? repoRecords.session("s-9", repo) : null;
  eq("cost added up across processes, thinking summed", s9 !== null ? s9.costUsd.toFixed(2) + " " + String(s9.thinkingTokens) + " " + s9.model : "none", "0.05 50 claude-haiku-4-5");
  await wait(1500);
  eq("the first turn asked for a title, once", titles.join(","), "s-9=Rename the helper");
  app.host.kernel.stop();
  ws.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  done();
};

main();
