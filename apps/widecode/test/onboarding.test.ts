// ffi: @light/plugins/native/ffi.json
// The first run and a folder's first access (shell/onboarding.ts), as questions in the request panel
// one after the other: the welcome in the chat (also on /welcome), the agent, the model, the folder's
// trust (what it carries: the agent's files, each harness plugin file's ids or why it does not load,
// the prompt, the config's keys; Trust, Look only, Exit) and the keys last; a later launch in a
// folder not trusted asks the folder alone; the agent stays out of an untrusted folder (a message,
// a mode, a resumed session refused) until /trust; the store's first run known from the config it
// had to write; a config key kept.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { checkSource } from "../src/api/plugins.ts";
import { Store } from "../src/services/store.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { AgentChoice, HarnessFile, Onboarding, folderCarries, runOnboarding, welcome, welcomeText } from "../src/views/onboarding.ts";
import { createWidecode, Widecode } from "../src/compose.ts";
import { Run } from "@light/ui/line-view.ts";
import { KeyEvent } from "@bootstrapp/light/native/tui";
import { done, eq, ok } from "@light/test/assert.ts";

const chatOf = (w: Widecode): string => {
  const s = w.chat.pane.source;
  s.prepare(160);
  const out: string[] = [];
  for (let i = 0; i < s.count(); i++) out.push(s.line(i, 160).runs.map((r: Run) => r.text).join(""));
  return out.join("\n").replace(/\s+/g, " ");
};

const main = async (): Promise<void> => {
  const home = mkdtempSync(join(tmpdir(), "widecode-onboarding-home-"));
  const folder = mkdtempSync(join(tmpdir(), "widecode-onboarding-"));
  mkdirSync(join(folder, ".widecode", "plugins"), { recursive: true });
  mkdirSync(join(folder, ".claude", "hooks"), { recursive: true });
  writeFileSync(join(folder, "CLAUDE.md"), "# Project\n");
  writeFileSync(join(folder, ".mcp.json"), "{}");
  writeFileSync(join(folder, ".widecode", "plugins", "a.js"), 'widecode.plugin({ id: "zed", activate(api) {} });\nwidecode.plugin({ id: "status", activate(api) {} });');
  writeFileSync(join(folder, ".widecode", "plugins", "b.js"), "widecode.plugin({ id: ");
  writeFileSync(join(folder, ".widecode", "prompt.md"), "Be terse.\n");
  writeFileSync(join(folder, ".widecode", "config.json"), '{"plugins":{},"permissions":{"deny":["Bash(rm -rf *)"]}}');
  const store = new Store(home);
  const ws = await openWorkspace(folder, 100);
  const w = createWidecode(ws, new Conversation(ws.folder), null);
  const first = store.loadConfig(w.defaults());
  ok("the store's first run: the config it had to write", store.firstRun && first.notice.length === 0);
  eq("not the second", String(new Store(home).loadConfig(w.defaults()).plugins !== null) + " " + String(new Store(home).firstRun), "true false");
  await w.host.useStore(store);
  const logs: string[] = [];
  w.host.onLog = (text: string) => logs.push(text);
  await w.host.load();
  const panel = w.chat.pane.panel;
  const open = (): string => w.host.conversation.model.openRequests().map((r) => r.name).join(",");
  const question = (): { question: string; header: string; options: { label: string; description: string }[] } => w.host.conversation.model.openRequests()[0].questions[0];
  const tell = (text: string): string => {
    w.host.roles.chat.submit(text);
    return w.host.screen.message.peek();
  };

  ok("a folder with a store is not trusted until the user says so", !w.host.session.trusted.peek() && !w.host.harness.trusted);
  eq("the agent stays out: a message is refused and says why", tell("hello"), "this folder is not trusted: /trust lets Claude work here");
  eq("a mode too", w.host.conversation.setMode("plan").length === 0 ? "the core alone allows it" : "refused", "the core alone allows it");

  const text = welcomeText(w.host);
  ok("the welcome names the columns' keys, the composer's, the commands, the trust", text.startsWith("Welcome to widecode.") && text.includes("F1") && text.includes("/help") && text.includes("/trust") && text.includes("clears the message, and quits when it is empty"));
  welcome(w.host);
  ok("in the chat", chatOf(w).includes("Welcome to widecode."));
  w.host.kernel.commands.run("/welcome");
  eq("/welcome shows it again", String(chatOf(w).split("Welcome to widecode.").length), "3");

  const carries = folderCarries(w.host, (file: string) => {
    const c = checkSource(w.js, readFileSync(file, "utf8"), file);
    return new HarnessFile(file.slice(folder.length + 1), c.ids, c.errors.length > 0 ? c.errors[0] : "");
  });
  eq("what the folder carries: the agent's files present, the harness's parts", [carries.agentFiles.join(","), carries.harnessFiles.map((f) => f.file + ":" + f.ids.join("+") + ":" + (f.error.length > 0 ? "err" : "ok")).join(","), String(carries.promptLength), carries.configKeys.join(",")].join(" | "), "CLAUDE.md,.claude/hooks,.mcp.json | .widecode/plugins/a.js:zed+status:ok,.widecode/plugins/b.js::err | 9 | plugins,permissions");

  // The first run, in the untrusted folder: the agent, the model, the folder, the keys, in that order.
  const o = new Onboarding();
  o.firstRun = true;
  o.trusted = false;
  o.carries = carries;
  o.agents = [new AgentChoice("claude", "Claude"), new AgentChoice("opencode", "opencode")];
  o.models = ["opus[1m]", "fable[1m]"];
  const did: string[] = [];
  o.onAgent = (id: string) => did.push("agent " + id);
  o.onModel = (name: string) => did.push("model " + name);
  o.onTrust = () => did.push("trust");
  o.onLookOnly = () => did.push("look");
  o.onExit = () => did.push("exit");
  runOnboarding(w.host, o);
  ok("the welcome, then the agent asked first", chatOf(w).split("Welcome to widecode.").length === 4 && open() === "Agent" && panel.active && question().options.map((x) => x.label).join(",") === "Claude,opencode");
  panel.key(new KeyEvent("char", "1", false, false, false), true);
  ok("then the model, Claude Code's list", open() === "Model" && question().options.map((x) => x.label).join(",") === "opus[1m],fable[1m]");
  panel.key(new KeyEvent("char", "2", false, false, false), true);
  ok("then the folder: what it carries and what trusting means", open() === "Trust" && question().header === "Folder" && question().question.startsWith("Do you trust this folder, " + folder + "?"));
  const q = question().question;
  ok("the agent's files, each plugin file with its ids or why it does not load, the prompt, the config's keys, the warning", q.includes("the agent reads CLAUDE.md, .claude/hooks, .mcp.json") && q.includes(".widecode/plugins/a.js (zed, status)") && q.includes(".widecode/plugins/b.js (does not load: SyntaxError") && q.includes(".widecode/prompt.md (9 characters)") && q.includes(".widecode/config.json (plugins, permissions)") && q.includes("A repository you cloned may carry files you did not write"));
  eq("the three answers", question().options.map((x) => x.label).join(","), "Trust this folder,Look only,Exit");
  panel.key(new KeyEvent("char", "1", false, false, false), true);
  ok("then the keys, last: default, emacs and vi", open() === "Keymap" && question().options.map((x) => x.label).join(",") === "Default,Emacs,Vi");
  panel.key(new KeyEvent("char", "3", false, false, false), true);
  eq("each answer did its thing, in order; the keymap in use and kept", did.join(" | ") + " / " + w.host.keys.keymap + " " + String(w.host.kernel.settings.state("keymap")) + " " + open(), "agent claude | model fable[1m] | trust / vi vi ");

  // A later launch in a folder not trusted: the folder alone; Look only and Exit.
  const later = (): Onboarding => {
    const x = new Onboarding();
    x.trusted = false;
    x.carries = carries;
    x.agents = o.agents;
    x.models = o.models;
    x.onTrust = () => did.push("trust");
    x.onLookOnly = () => did.push("look");
    x.onExit = () => did.push("exit");
    return x;
  };
  did.length = 0;
  runOnboarding(w.host, later());
  ok("not the first run: the folder's question alone", open() === "Trust");
  panel.key(new KeyEvent("char", "2", false, false, false), true);
  eq("Look only", did.join(",") + " " + open(), "look ");
  runOnboarding(w.host, later());
  panel.key(new KeyEvent("escape", "", false, false, false), true);
  eq("Esc is Look only too", did.join(","), "look,look");
  runOnboarding(w.host, later());
  panel.key(new KeyEvent("char", "3", false, false, false), true);
  eq("Exit", did.join(","), "look,look,exit");
  runOnboarding(w.host, later());
  w.host.roles.chat.submit("sure, go ahead");
  eq("an answer in words is Look only, and the words do not reach the agent", did.join(","), "look,look,exit,look");
  const t = later();
  t.trusted = true;
  runOnboarding(w.host, t);
  eq("a trusted folder, not the first run: nothing asked", open(), "");

  // Trusted: the agent works, the harness runs; the store remembers.
  store.trust(folder);
  await w.host.useStore(store);
  ok("trusted as the store remembers", w.host.session.trusted.peek() && w.host.harness.trusted && store.trusted(folder));
  const said = tell("hello");
  ok("a message goes to the agent now, no longer refused for trust", !said.includes("not trusted"));
  w.host.conversation.kill();

  eq("a config key kept, the others as they were", store.setConfigValue("agent", "opencode") + " " + String((JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { agent: string; clipboard: string }).agent) + " " + String((JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { agent: string; clipboard: string }).clipboard), " opencode auto");
  eq("and read on the next load", new Store(home).loadConfig(w.defaults()).agent, "opencode");

  w.host.kernel.stop();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
