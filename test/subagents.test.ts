// ffi: @lightstart/plugins/native/ffi.json
// /subagents: which subagents the session runs, Claude Code's own, lightcode's Task over the acp
// plugin's targets, or both. The choice comes from state.json, else from
// `replaceClaudeSubagents` and `plugins.claude.keepSubagents`; it reaches Claude Code's start as
// `--disallowedTools` and `--settings.env.CLAUDE_CODE_SUBAGENT_MODEL`, and is kept for the next
// run. /subagents says the choice and completes it; without acp targets only Claude's own are
// offered.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { Answer, Reply } from "../src/conversation/requests.ts";
import { NoStateFile, StateFile } from "@lightstart/kernel/settings.ts";
import type { Lightcode } from "../src/compose.ts";
import { closeLightcode, openLightcode } from "./support/app.ts";
import { Store } from "../src/services/store.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";

const fake = join(process.cwd(), "test/fake-claude.mjs");
const fakeAcp = join(process.cwd(), "test/fake-acp.mjs");
const fixture = join(process.cwd(), "test/fixtures/edit.ndjson");
const askFixture = join(process.cwd(), "test/fixtures/ask.ndjson");

/** Any parsed JSON object, every field unknown. */
interface Rec {
  [key: string]: unknown;
}

const rec = (v: unknown): Rec | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null);

/** The config the acp plugin's tasks make: lightcode's Task over one target, Claude's own replaced when `replace`. */
const taskConfig = (replace: boolean): unknown => ({
  models: { list: ["opus[1m]", "fable[1m]"] },
  acp: { tasks: { replaceClaudeSubagents: replace, targets: { deepseek: { agent: "fake", model: "fake/large" } } } },
});

/** An app started on `plugins`, with Claude's CLI pointed at the fake and its arguments recorded in `argsFile`; `fixturePath` is the recording it replays. */
const open = async (folder: string, plugins: unknown, state: StateFile, argsFile: string, withTask: boolean, fixturePath: string = fixture): Promise<{ c: Conversation; w: Lightcode }> => {
  const w = await openLightcode({ folder, plugins, state, load: true });
  const c = w.host.conversation;
  c.executable = fake;
  c.extraArgs.push("--fixture", fixturePath, "--record-args", argsFile);
  if (withTask)
    await until(() => {
      const command = w.host.kernel.commands.find("/subagents");
      return command !== null && command.onComplete !== null && command.onComplete("lightcode").length > 0;
    }, 5000);
  else await new Promise<void>((resolve) => setTimeout(resolve, 100));
  return { c, w };
};

const quit = (app: { c: Conversation; w: Lightcode }): void => {
  closeLightcode(app.w);
};

/** The arguments the fake recorded, one per line. */
const recorded = async (argsFile: string): Promise<string[]> => {
  await until(() => existsSync(argsFile), 5000);
  return existsSync(argsFile) ? readFileSync(argsFile, "utf8").split("\n").filter((l) => l.length > 0) : [];
};

const after = (args: string[], flag: string): string => {
  const at = args.indexOf(flag);
  return at >= 0 ? (args[at + 1] ?? "") : "";
};

const settingsOf = (args: string[]): Rec | null => {
  const text = after(args, "--settings");
  if (text.length === 0) return null;
  try {
    return rec(JSON.parse(text));
  } catch {
    return null;
  }
};

const said = (w: Lightcode): string => w.host.screen.message.peek();

/** Answer the first open request with its first option, so the fake's turn can end. */
const answer = (c: Conversation): void => {
  const open = c.model.openRequests();
  if (open.length === 0) return;
  const reply = new Reply("answered");
  const a = new Answer(open[0].questions[0].question, false);
  a.labels.push(open[0].questions[0].options[0].label);
  reply.answers.push(a);
  c.respond(open[0], reply);
};

const main = async (): Promise<void> => {
  // The config's default: Claude's own subagent tools step aside for lightcode's Task.
  const folder = mkdtempSync(join(tmpdir(), "lightcode-subagents-"));
  const app = await open(folder, taskConfig(true), new NoStateFile(), join(folder, "args-lightcode.txt"), true);
  app.w.host.roles.chat.submit("/subagents");
  eq("the default says lightcode's Task on the target", said(app.w), "subagents: deepseek via Task");
  const command = app.w.host.kernel.commands.find("/subagents");
  const choices = command !== null && command.onComplete !== null ? command.onComplete("") : [];
  const values = choices.map((s) => s.value);
  ok("the completion has Claude's own, the config's models, and both modes", values.join(",") === "claude,claude opus,claude sonnet,claude haiku,claude opus[1m],claude fable[1m],lightcode,both");
  eq("the current choice is marked", choices.find((s) => s.value === "lightcode")?.detail ?? "", "now");
  eq("and a prefix narrows it", (command !== null && command.onComplete !== null ? command.onComplete("claude s") : []).map((s) => s.value).join(","), "claude sonnet");
  app.c.send("go", []);
  const lightcodeArgs = await recorded(join(folder, "args-lightcode.txt"));
  eq("lightcode's Task starts without Claude's own subagent tools", after(lightcodeArgs, "--disallowedTools"), "Task,Agent,TaskStop,SendMessage");
  quit(app);

  // replaceClaudeSubagents off: both, with nothing disallowed.
  const bothFolder = mkdtempSync(join(tmpdir(), "lightcode-subagents-both-"));
  const bothApp = await open(bothFolder, taskConfig(false), new NoStateFile(), join(bothFolder, "args.txt"), true);
  bothApp.w.host.roles.chat.submit("/subagents");
  eq("the config's other default is both", said(bothApp.w), "subagents: Claude's own and deepseek");
  bothApp.c.send("go", []);
  const bothArgs = await recorded(join(bothFolder, "args.txt"));
  ok("both disallows neither", !bothArgs.includes("--disallowedTools"));
  quit(bothApp);

  // Claude's own on a model: lightcode's Task is hidden from Claude and its model goes in the settings.
  const sonnetFolder = mkdtempSync(join(tmpdir(), "lightcode-subagents-sonnet-"));
  const sonnetApp = await open(sonnetFolder, taskConfig(true), new NoStateFile(), join(sonnetFolder, "args.txt"), true);
  sonnetApp.w.host.roles.chat.submit("/subagents claude sonnet");
  eq("choosing Claude's own says it, and when it applies", said(sonnetApp.w), "subagents: Claude's own on sonnet");
  sonnetApp.c.send("go", []);
  const sonnetArgs = await recorded(join(sonnetFolder, "args.txt"));
  eq("lightcode's Task is hidden", after(sonnetArgs, "--disallowedTools"), "mcp__lightcode__Task,mcp__lightcode__TaskStop,mcp__lightcode__SendMessage");
  const sonnetSettings = settingsOf(sonnetArgs);
  const sonnetEnv = rec(sonnetSettings !== null ? sonnetSettings.env : null);
  eq("the subagent model reaches Claude Code", typeof sonnetEnv?.CLAUDE_CODE_SUBAGENT_MODEL === "string" ? sonnetEnv.CLAUDE_CODE_SUBAGENT_MODEL : "", "sonnet");
  eq("and holds over an agent's own model", typeof sonnetEnv?.CLAUDE_CODE_SUBAGENT_MODEL_FORCE === "string" ? sonnetEnv.CLAUDE_CODE_SUBAGENT_MODEL_FORCE : "", "1");
  ok("and Claude's own tools are not disallowed", !sonnetArgs.includes("Task,Agent"));
  quit(sonnetApp);

  // Claude's own with no model: the variable is left out.
  const inheritedFolder = mkdtempSync(join(tmpdir(), "lightcode-subagents-inherit-"));
  const inheritedApp = await open(inheritedFolder, taskConfig(true), new NoStateFile(), join(inheritedFolder, "args.txt"), true);
  inheritedApp.w.host.roles.chat.submit("/subagents claude");
  inheritedApp.c.send("go", []);
  const inheritedArgs = await recorded(join(inheritedFolder, "args.txt"));
  ok("inheriting the subagent model sets no env and no settings", !inheritedArgs.includes("--settings") && !inheritedArgs.includes("CLAUDE_CODE_SUBAGENT_MODEL"));
  quit(inheritedApp);

  // Both chosen explicitly: neither is disallowed.
  const pairFolder = mkdtempSync(join(tmpdir(), "lightcode-subagents-pair-"));
  const pairApp = await open(pairFolder, taskConfig(true), new NoStateFile(), join(pairFolder, "args.txt"), true);
  pairApp.w.host.roles.chat.submit("/subagents both");
  eq("both is told", said(pairApp.w), "subagents: Claude's own and deepseek");
  pairApp.c.send("go", []);
  const pairArgs = await recorded(join(pairFolder, "args.txt"));
  ok("both keeps both", !pairArgs.includes("--disallowedTools"));
  quit(pairApp);

  // The choice is kept for the next lightcode.
  const home = mkdtempSync(join(tmpdir(), "lightcode-subagents-home-"));
  const keptFolder = mkdtempSync(join(tmpdir(), "lightcode-subagents-kept-"));
  const first = await open(keptFolder, taskConfig(true), new Store(home).stateFile(), join(keptFolder, "args.txt"), true);
  first.w.host.roles.chat.submit("/subagents claude sonnet");
  quit(first);
  const kept = await open(keptFolder, taskConfig(true), new Store(home).stateFile(), join(keptFolder, "args-kept.txt"), true);
  kept.w.host.roles.chat.submit("/subagents");
  eq("the next lightcode starts with it", said(kept.w), "subagents: Claude's own on sonnet");
  quit(kept);

  // No acp targets: only Claude's own are offered, whatever the config says.
  const aloneFolder = mkdtempSync(join(tmpdir(), "lightcode-subagents-alone-"));
  const aloneApp = await open(aloneFolder, {}, new NoStateFile(), join(aloneFolder, "args.txt"), false);
  const aloneCommand = aloneApp.w.host.kernel.commands.find("/subagents");
  const aloneValues = aloneCommand !== null && aloneCommand.onComplete !== null ? aloneCommand.onComplete("").map((s) => s.value) : ["none"];
  ok("without lightcode's Task only Claude's own are listed", aloneValues.every((v) => v.startsWith("claude")) && !aloneValues.includes("lightcode") && !aloneValues.includes("both"));
  aloneApp.w.host.roles.chat.submit("/subagents");
  eq("and the default is Claude's own", said(aloneApp.w), "subagents: Claude's own");
  aloneApp.w.host.roles.chat.submit("/subagents lightcode");
  ok("a mode it does not offer is refused with the ones it does", said(aloneApp.w).startsWith("subagents: choose "));
  aloneApp.w.host.roles.chat.submit("/subagents claude haiku");
  aloneApp.c.send("go", []);
  const aloneArgs = await recorded(join(aloneFolder, "args.txt"));
  ok("Claude's own on haiku, with nothing disallowed", after(aloneArgs, "--settings").includes("haiku") && !aloneArgs.includes("--disallowedTools"));
  quit(aloneApp);

  // A choice made while a turn is open waits for the turn's end, then restarts the CLI on the same
  // session with the new flags.
  const openTurnFolder = mkdtempSync(join(tmpdir(), "lightcode-subagents-open-turn-"));
  const openTurnArgs = join(openTurnFolder, "args.txt");
  const openTurnApp = await open(openTurnFolder, taskConfig(true), new NoStateFile(), openTurnArgs, true, askFixture);
  openTurnApp.c.send("go", []);
  ok("a question holds the turn open", await until(() => openTurnApp.c.model.openRequests().length > 0, 10000));
  const openTurnSid = openTurnApp.c.sessionId;
  rmSync(openTurnArgs, { force: true });
  openTurnApp.w.host.kernel.commands.run("/subagents claude sonnet");
  eq("the choice waits for the turn's end", said(openTurnApp.w), "subagents: Claude's own on sonnet, after this turn");
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  ok("the CLI goes on with the turn, not restarted yet", openTurnApp.c.started && !existsSync(openTurnArgs));
  answer(openTurnApp.c);
  ok("at the turn's end the CLI stops to take the choice", await until(() => !openTurnApp.c.started, 10000));
  openTurnApp.c.send("again", []);
  const resumedArgs = await recorded(openTurnArgs);
  eq("the next start resumes the session and hides lightcode's Task", after(resumedArgs, "--resume") + " | " + after(resumedArgs, "--disallowedTools"), openTurnSid + " | mcp__lightcode__Task,mcp__lightcode__TaskStop,mcp__lightcode__SendMessage");
  const resumedSettings = settingsOf(resumedArgs);
  const resumedEnv = rec(resumedSettings !== null ? resumedSettings.env : null);
  eq("and carries the subagent model", typeof resumedEnv?.CLAUDE_CODE_SUBAGENT_MODEL === "string" ? resumedEnv.CLAUDE_CODE_SUBAGENT_MODEL : "", "sonnet");
  quit(openTurnApp);

  // Any model alias or id is taken, but not one with a space.
  const idFolder = mkdtempSync(join(tmpdir(), "lightcode-subagents-id-"));
  const idArgsFile = join(idFolder, "args.txt");
  const idApp = await open(idFolder, taskConfig(true), new NoStateFile(), idArgsFile, true);
  idApp.w.host.roles.chat.submit("/subagents claude two words");
  eq("a model with a space is refused with the choices", said(idApp.w), "subagents: choose claude, claude opus, claude sonnet, claude haiku, claude opus[1m], claude fable[1m], lightcode, both");
  const idKept = rec(idApp.w.host.kernel.settings.state("claude"));
  eq("and nothing is kept", JSON.stringify(idKept !== null ? idKept.subagents : null), "null");
  idApp.w.host.roles.chat.submit("/subagents claude claude-sonnet-5");
  eq("a full id is accepted", said(idApp.w), "subagents: Claude's own on claude-sonnet-5");
  idApp.c.send("go", []);
  const idArgs = await recorded(idArgsFile);
  const idSettings = settingsOf(idArgs);
  const idEnv = rec(idSettings !== null ? idSettings.env : null);
  eq("and reaches Claude Code's env", typeof idEnv?.CLAUDE_CODE_SUBAGENT_MODEL === "string" ? idEnv.CLAUDE_CODE_SUBAGENT_MODEL : "", "claude-sonnet-5");
  quit(idApp);

  // Another main agent: /subagents says so and keeps the choice as it was.
  const acpFolder = mkdtempSync(join(tmpdir(), "lightcode-subagents-acp-"));
  const acpHome = mkdtempSync(join(tmpdir(), "lightcode-subagents-acp-home-"));
  const acpApp = await open(
    acpFolder,
    { acp: { agents: { fake: { name: "Fake", command: ["node", fakeAcp] } }, tasks: { replaceClaudeSubagents: true, targets: { deepseek: { agent: "fake", model: "fake/large" } } } } },
    new Store(acpHome).stateFile(),
    join(acpFolder, "args.txt"),
    true,
  );
  acpApp.w.host.roles.chat.submit("/subagents both");
  eq("both is kept while Claude is the main agent", said(acpApp.w), "subagents: Claude's own and deepseek");
  acpApp.w.host.session.useAgent("fake");
  acpApp.w.host.roles.chat.submit("/subagents claude");
  eq("another main agent is told, not changed", said(acpApp.w), "subagents: deepseek via Task (main: Fake)");
  const acpKept = rec(acpApp.w.host.kernel.settings.state("claude"));
  eq("the kept choice is unchanged", JSON.stringify(acpKept !== null ? acpKept.subagents : null), '{"mode":"both","model":""}');
  acpApp.w.host.session.useAgent("claude");
  acpApp.w.host.roles.chat.submit("/subagents");
  eq("and Claude still reads it", said(acpApp.w), "subagents: Claude's own and deepseek");
  quit(acpApp);

  // A new model while already in Claude's mode stops the CLI at once; the next message starts it.
  const modelFolder = mkdtempSync(join(tmpdir(), "lightcode-subagents-model-"));
  const modelArgs = join(modelFolder, "args.txt");
  const modelApp = await open(modelFolder, taskConfig(true), new NoStateFile(), modelArgs, true, askFixture);
  modelApp.w.host.roles.chat.submit("/subagents claude sonnet");
  modelApp.c.send("go", []);
  ok("the first turn is held", await until(() => modelApp.c.model.openRequests().length > 0, 10000));
  answer(modelApp.c);
  ok("it ends and the CLI stays between turns", await until(() => !modelApp.c.model.running && modelApp.c.started, 10000));
  rmSync(modelArgs, { force: true });
  modelApp.w.host.roles.chat.submit("/subagents claude opus");
  eq("the new model applies from the next message", said(modelApp.w), "subagents: Claude's own on opus");
  ok("the CLI is stopped at once", await until(() => !modelApp.c.started, 5000));
  modelApp.c.send("again", []);
  const opusArgs = await recorded(modelArgs);
  const opusSettings = settingsOf(opusArgs);
  const opusEnv = rec(opusSettings !== null ? opusSettings.env : null);
  eq("and the next start carries it", typeof opusEnv?.CLAUDE_CODE_SUBAGENT_MODEL === "string" ? opusEnv.CLAUDE_CODE_SUBAGENT_MODEL : "", "opus");
  quit(modelApp);

  rmSync(folder, { recursive: true, force: true });
  rmSync(bothFolder, { recursive: true, force: true });
  rmSync(sonnetFolder, { recursive: true, force: true });
  rmSync(inheritedFolder, { recursive: true, force: true });
  rmSync(pairFolder, { recursive: true, force: true });
  rmSync(keptFolder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(aloneFolder, { recursive: true, force: true });
  rmSync(openTurnFolder, { recursive: true, force: true });
  rmSync(idFolder, { recursive: true, force: true });
  rmSync(acpFolder, { recursive: true, force: true });
  rmSync(acpHome, { recursive: true, force: true });
  rmSync(modelFolder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
