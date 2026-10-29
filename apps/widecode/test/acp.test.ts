// ffi: @light/plugins/native/ffi.json
// An agent over ACP (plugins/acp.ts), here the fake (test/fake-acp.mjs) from the
// plugin's section, speaking as opencode 1.19 does: its session, started with widecode, its model,
// effort, mode and commands (config options); a reply and its thinking, two messages as two blocks; a run call with its
// output; an edit with its diff, followed by the code column; a permission allowed and one
// declined; a todo list and a subagent from their calls' input; a message sent meanwhile waiting
// for the turn, Esc cancelling it; an error; mode, model and effort switched, and ones it has not;
// its process ending mid-turn and starting again on the same session; its sessions in the Sessions
// tab (from its command, then from the agent), one pressed there loaded as turns. An agent speaking
// as opencode 1.2 did (modes and models, set_mode, a plan update) beside it. The chat and models
// plugins work from what each offers: /plan and Shift+Tab, /effort, /model by a part of a name or
// chosen from its list as it is typed, F5 through the config's list for the agent. Switched off, its agents are gone.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { Item, NOTICE, TEXT, THINKING, TOOL, Turn } from "@widecode/conversation/model.ts";
import { Answer, Reply } from "@widecode/conversation/requests.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { KeyEvent, setValue } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

const kinds = (items: Item[]): string => items.map((i: Item) => (i.kind === THINKING ? "thinking" : i.kind === TEXT ? "text" : i.kind === TOOL ? "tool" : i.kind === NOTICE ? "notice:" + i.text : "other")).join(",");

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-acp-"));
  writeFileSync(join(folder, "a.txt"), "one\n");
  const log = join(folder, "fake.log");
  const oldLog = join(folder, "old.log");
  const fake = join(process.cwd(), "test/fake-acp.mjs");
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  w.host.session.agentId.value = "fake";
  const config: unknown = {
    models: { agents: { fake: ["fake/small", "fake/large"] } },
    acp: {
      agents: {
        fake: { name: "Fake", command: ["node", fake, "--log", log], sessions: ["node", fake, "--sessions"] },
        old: { name: "Old", command: ["node", fake, "--legacy", "--log", oldLog] },
      },
    },
  };
  w.start(config, new NoStateFile(), []);
  // As widecode starts: an ACP agent's session starts with it.
  c.prepare();
  await w.host.load();
  const idle = (): boolean => !c.model.running && c.model.pending.length === 0;
  const last = (): Turn => c.model.turns[c.model.turns.length - 1];
  const sent = (): string => readFileSync(log, "utf8");
  const chat = (): string[] => {
    const s = w.chat.pane.source;
    s.prepare(80);
    const out: string[] = [];
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 80).runs.map((r: Run) => r.text).join("").replace(/\s+$/, ""));
    return out;
  };
  /** Send `text` and wait for the turn it starts to end. */
  const turn = async (text: string): Promise<boolean> => {
    const before = c.model.turns.length;
    w.host.roles.chat.submit(text);
    return until(() => c.model.turns.length > before && idle());
  };
  /** The Sessions tab's rows, and a press on the first row naming `text`. */
  const sessionRows = (): string[] => {
    const p = w.host.screen.findPanel("sessions");
    const out: string[] = [];
    if (p === null) return out;
    const s = p.view.source;
    s.prepare(60);
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 60).runs.map((r: Run) => r.text).join("").trim());
    return out;
  };
  /** A press on the session named `text` in the tab chooses it; Enter there opens it in place of the chat's. */
  const pressSession = (text: string): void => {
    const p = w.host.screen.findPanel("sessions");
    const at = sessionRows().findIndex((l: string) => l.includes(text));
    if (p !== null && at >= 0) p.press(at, 0);
    const open = w.host.kernel.actions.find("sessions.resume");
    if (open !== null) open.onRun(new KeyEvent("enter", "", false, false, false), 1);
  };
  eq("the agent from the section, and opencode beside it", c.agent.id() + " " + c.agent.name() + " " + String(w.host.session.agents.some((a) => a.id() === "opencode")), "fake Fake true");
  ok("named on the screen", w.chat.pane.input.placeholder.startsWith("Write to Fake."));
  ok("its session starts with widecode: the model it runs on and its efforts known before any message", (await until(() => c.info.modelId === "fake/small")) && c.started && c.agent.choices().efforts.map((e) => e.value).join(",") === "low,high,default" && sent().includes('"method":"session/new"') && !sent().includes('"method":"session/prompt"'));
  w.host.screen.showPanel("sessions");
  ok("its sessions in the Sessions tab, from its command before it runs", await until(() => sessionRows().includes("An earlier session")));

  ok("a turn", await turn("hello"));
  ok("the prompt, and the reply from two chunks", await until(() => chat().some((l: string) => l.includes("<Me>: hello")) && chat().some((l: string) => l.includes("Hello, world."))));
  eq("its thinking, then its text", kinds(last().body.children), "thinking,text");
  eq("the session, its model, effort and mode, its commands", c.sessionId + " " + c.info.modelId + " " + c.info.effort + " " + c.model.permissionMode + " " + c.model.slashCommands.join(","), "fake-1 fake/small default build init,review");
  const r = last().result;
  eq("the turn's end", r === null ? "none" : r.subtype + " " + String(r.isError), "end_turn false");
  ok("the handshake: initialize, then a session in the folder", sent().includes('"method":"initialize"') && sent().includes('"method":"session/new","params":{"cwd":"' + folder + '"'));
  ok("then from the agent, the new one first", await until(() => sessionRows()[0] === "● Session fake-1" && sessionRows()[2] === "An earlier session" && sent().includes('"method":"session/list","params":{"cwd":"' + folder + '"}')));

  ok("two messages", await turn("two"));
  eq("as two blocks", kinds(last().body.children) + " " + last().body.children.map((i: Item) => i.text).join(" "), "text,text First. Second.");

  ok("a run call", await turn("run"));
  const run = c.model.tool("call_run");
  eq("its kind, name, line, command, output, and no file (its folder is where it ran)", run === null || run.result === null ? "" : [run.category, run.name, run.summary, run.command, run.result.text, String(run.paths.length)].join(" | "), "run | Run | ls -1 | ls -1 | a.txt\nb.txt | 0");
  ok("one line in the chat for it", await until(() => chat().some((l: string) => l.startsWith("· Run ls -1"))));
  eq("counted as a run", String(c.info.execs) + "/" + String(c.info.calls), "1/1");

  ok("an edit", await turn("edit"));
  const edit = c.model.tool("call_edit");
  const hunks = edit === null || edit.result === null ? "" : edit.result.patch.map((h) => String(h.oldStart) + "," + String(h.newStart) + ":" + h.lines.join("|")).join(" ");
  eq("its file, its line, its diff over the whole file (its lines' numbers)", (edit === null ? "" : edit.category + " " + edit.paths.join(",") + " " + edit.summary) + " " + hunks, "edit " + join(folder, "a.txt") + " a.txt 6,6: l6| l7| one|+two| l9| l10");
  eq("the code column follows it", c.model.lastEdit, join(folder, "a.txt"));

  w.host.roles.chat.submit("ask");
  ok("a permission asked", await until(() => c.model.openRequests().length === 1));
  const req = c.model.openRequests()[0];
  eq("its question and options", req.category + " " + req.questions[0].question + " " + req.questions[0].options.map((o) => o.label).join("/"), "permission Run rm a.txt: allow it? Allow once/Always allow/Reject");
  ok("the panel open for it", w.chat.pane.panel.active);
  const allow = new Reply("answered");
  const a = new Answer(req.questions[0].question, false);
  a.labels.push("Allow once");
  allow.answers.push(a);
  c.respond(req, allow);
  ok("allowed: the call ran", await until(() => idle()));
  const allowed = c.model.tool("call_ask");
  eq("its result, the option sent", (allowed === null || allowed.result === null ? "" : allowed.result.text) + " " + String(sent().includes('"outcome":{"outcome":"selected","optionId":"once"}')), "removed true");
  w.host.roles.chat.submit("ask quietly");
  await until(() => c.model.openRequests().length === 1);
  const decline = new Reply("declined");
  decline.message = "no";
  c.respond(c.model.openRequests()[0], decline);
  await until(() => idle());
  const rejected = c.model.tool("call_ask");
  eq("declined (a call it did not announce, shown from the request): rejected, the call failed", (rejected === null || rejected.result === null ? "" : rejected.result.text + " " + String(rejected.result.isError)) + " " + String(sent().includes('"optionId":"reject"')), "rejected by the user true true");

  ok("a todo list", await turn("plan"));
  const plan = c.model.tool("call_todo");
  eq("from its call's input", plan === null ? "" : plan.category + " " + plan.name + " " + plan.todos.map((t) => t.state + ":" + t.text).join(", "), "todo Todo done:read the code, doing:write the test, todo:run it");
  ok("a subagent", await turn("task"));
  const task = c.model.tool("call_task");
  eq("from its call's input", task === null ? "" : [task.category, task.name, task.agentType, task.agentTask, task.summary].join(" | "), "agent | Agent | explore | find the tests | explore: find the tests");

  w.host.roles.chat.submit("slow");
  ok("a long turn", await until(() => chat().some((l: string) => l.includes("Working…"))));
  w.host.roles.chat.submit("hello again");
  ok("a message meanwhile waits for it", c.model.running && c.model.pending.length === 1 && c.model.pending[0].text === "hello again");
  const slowAt = c.model.turns.length - 1;
  c.interrupt();
  ok("Esc cancels it, then the message goes", await until(() => c.model.turns.length === slowAt + 2 && idle()));
  const slow = c.model.turns[slowAt];
  eq("cancelled", kinds(slow.body.children) + " " + (slow.result === null ? "" : slow.result.subtype), "text,notice:Interrupted cancelled");
  ok("the next one answered", last().prompt !== null && last().prompt?.text === "hello again" && kinds(last().body.children) === "thinking,text");

  ok("an error", await turn("fail"));
  const failed = last();
  eq("said, the turn failed", kinds(failed.body.children) + " " + String(failed.result !== null && failed.result.isError), "notice:Error true");

  eq("a mode it has", c.setMode("plan"), "");
  ok("switched, as a config option", (await until(() => c.model.permissionMode === "plan")) && sent().includes('"method":"session/set_config_option","params":{"sessionId":"fake-1","configId":"mode","value":"plan"}'));
  eq("a mode it has not", c.setMode("yolo"), "Fake has no mode yolo (it has build, plan)");
  c.setModel("fake/large");
  ok("a model it has", (await until(() => c.info.modelId === "fake/large")) && sent().includes('"configId":"model","value":"fake/large"'));
  c.setEffort("high");
  ok("an effort it has", (await until(() => c.info.effort === "high")) && sent().includes('"configId":"effort","value":"high"'));
  c.setEffort("max");
  ok("one it has not: said, the status back to the one it runs on", c.model.lastNoticeIs("Fake has no effort max (it has low, high, default)") && c.info.effort === "high");

  // The chat and models plugins, from what the agent offers.
  const said = (): string => w.host.screen.message.peek();
  w.host.roles.chat.submit("/plan");
  ok("/plan leaves plan mode for a mode it offers", (await until(() => c.model.permissionMode === "build")) && said() === "plan mode off");
  w.shell.handleKey(new KeyEvent("tab", "", false, false, true));
  ok("Shift+Tab: plan mode", (await until(() => c.model.permissionMode === "plan")) && said() === "plan mode: Fake plans and asks before changing anything");
  w.shell.handleKey(new KeyEvent("tab", "", false, false, true));
  ok("and back to the mode before it", await until(() => c.model.permissionMode === "build"));
  w.host.roles.chat.submit("/effort max");
  eq("/effort: one of its efforts", said(), "effort is one of low, high, default (now high)");
  w.host.roles.chat.submit("/effort low");
  ok("one it has", await until(() => c.info.effort === "low"));
  w.host.roles.chat.submit("/model small");
  ok("/model by a part of its name", await until(() => c.info.modelId === "fake/small"));
  w.host.roles.chat.submit("/model fake");
  eq("one that names more than one", said(), "fake matches fake/small, fake/large");
  w.shell.handleKey(new KeyEvent("f5", "", false, false, false));
  ok("F5: the next of the config's list for it", await until(() => c.info.modelId === "fake/large"));
  w.host.screen.focus("chat");
  // Typed: the composer's change (the screen is not mounted here, so it is called as the screen would).
  const typed = (text: string): void => {
    setValue(w.chat.pane.input, text);
    w.chat.pane.complete();
  };
  typed("/model ");
  eq("/model lists its models, the one it runs on first", w.chat.pane.strip.items.peek().map((s) => s.value + ":" + s.detail).join(","), "fake/large:now,fake/small:F5");
  typed("/model sma");
  w.shell.handleKey(new KeyEvent("enter", "", false, false, false));
  ok("typed, narrowed, Enter runs it with the one chosen", await until(() => c.info.modelId === "fake/small"));

  ok("its process ends mid-turn", await turn("exit"));
  ok("the turn ends with it", last().result !== null && last().result?.isError === true && !c.started);
  ok("the next message starts it again, on the same session", await turn("hello"));
  const loads = sent().split("\n").filter((l: string) => l.includes('"method":"session/load"'));
  ok("loaded, its turns not replayed", c.started && c.sessionId === "fake-1" && loads.length === 1 && loads[0].includes('"sessionId":"fake-1"') && kinds(last().body.children) === "thinking,text");

  pressSession("An earlier session");
  // Its replay and the load's answer may come in different batches of the agent's output.
  ok("a past session pressed in the tab", await until(() => chat().some((l: string) => l.includes("earlier answer")) && !c.model.running));
  eq("as its turns", String(c.model.turns.length) + " " + (c.model.turns[0].prompt?.text ?? "") + " " + kinds(c.model.turns[0].body.children) + " " + String(c.model.running), "1 earlier question text,tool false");
  const read = c.model.tool("past_read");
  eq("its calls whole", read === null || read.result === null ? "" : read.category + " " + read.summary + " " + read.result.text, "read a.txt one");
  ok("a message goes to it", await turn("hi"));
  ok("to the session loaded", sent().includes('"method":"session/prompt","params":{"sessionId":"past-1"'));

  c.reset();
  ok("/new: a new session on the next message", (await turn("hello")) && c.sessionId === "fake-2");

  // An agent speaking as opencode 1.2 did.
  eq("another agent of the section", w.host.session.useAgent("old"), "");
  c.reset();
  ok("a turn with it", await turn("hello"));
  eq("its reply in one block (it names no messages), the model chosen before (it has it) and its mode", kinds(last().body.children) + " " + c.info.modelId + " " + c.model.permissionMode, "thinking,text fake/small build");
  eq("a mode", c.setMode("plan"), "");
  ok("switched with set_mode", (await until(() => c.model.permissionMode === "plan")) && readFileSync(oldLog, "utf8").includes('"method":"session/set_mode"'));
  ok("a plan update", await turn("plan"));
  const oldPlan = c.model.tool("plan1");
  eq("as todos", oldPlan === null ? "" : oldPlan.category + " " + oldPlan.todos.map((t) => t.state + ":" + t.text).join(", "), "todo done:read the code, doing:write the test, todo:run it");
  w.host.roles.chat.submit("/effort low");
  eq("no effort to choose", said(), "Old has no effort to choose");
  w.shell.handleKey(new KeyEvent("f5", "", false, false, false));
  eq("F5 with no list in the config for it", said(), "F5 cycles the models config.json lists for Old (models.agents.old); /model <name> picks one of its 2");
  w.host.roles.chat.submit("/title");
  eq("its titles are its own", said(), "Old titles its own sessions");

  w.host.kernel.stop();
  w.js.killProcesses();

  // Switched off: its agents are not there to choose.
  const c2 = new Conversation(ws.folder);
  const w2 = composeWidecode(ws, c2);
  const off: unknown = { acp: false };
  w2.start(off, new NoStateFile(), []);
  await w2.host.load();
  ok("switched off: none of its agents", w2.host.session.useAgent("fake").startsWith("no agent named fake") && w2.host.session.useAgent("opencode").startsWith("no agent named opencode"));
  w2.host.kernel.stop();

  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
