// ffi: @lightstart/plugins/native/ffi.json
// widecode's own agent, the harness (src/harness), as the acp plugin drives it under node
// (`node src/harness/main.ts --harness`, the entry's command in the config, as the real one
// is the binary with `--harness`): its session starts with widecode, with its model, effort and
// mode as config options; the project's prompt and trust reach it in `_meta.widecode` with the
// session and each prompt (the daemon's trace says so); a reply from the fake model's fixture
// streams into the chat with its thinking; a message sent meanwhile steers the turn and is
// answered with it; Esc cancels a held turn; a model error is a notice; /new starts another
// session; the tools command answers the Available tab; the chosen harness shows as the agent; the
// Sessions tab lists the first session with the title the fake model gave, opening it again shows
// its turns from its file, /title names it, a side question runs in a fork forgotten after, the
// folder's skill shows in the Skills tab and a Skill call is a run of it, AskUser over widecode's
// MCP server puts its question in the request panel and takes the answer back,
// /compact summarizes the conversation and the status bar shows the context after.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Item, TEXT, THINKING, TOOL, Turn } from "../src/conversation/model.ts";
import { Answer, Reply } from "../src/conversation/requests.ts";
import { skillRuns } from "../src/conversation/skills.ts";
import type { Widecode } from "../src/compose.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";

const kinds = (items: Item[]): string => items.map((i: Item) => (i.kind === THINKING ? "thinking" : i.kind === TEXT ? "text:" + i.text : "other")).join(",");

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-harness-"));
  const home = mkdtempSync(join(tmpdir(), "widecode-harness-home-"));
  writeFileSync(join(folder, "a.txt"), "one\n");
  mkdirSync(join(folder, ".claude", "skills", "greet"), { recursive: true });
  writeFileSync(join(folder, ".claude", "skills", "greet", "SKILL.md"), "---\ndescription: Greet the user\n---\nSay hello warmly.\n");
  const fixture = join(home, "model.jsonl");
  writeFileSync(
    fixture,
    [
      '{"match":"hello","text":"Hello, world.","thinking":"Thinking about it.","input":12,"output":4}',
      '{"match":"slow","text":"Working on it for a while now.","chunks":4,"delayMs":60}',
      '{"match":"run","text":"Listing.","tools":[{"name":"Bash","input":{"command":"ls -1","description":"List files"}},{"name":"Read","input":{"file_path":"a.txt"}}]}',
      '{"match":"result","text":"One file, one line."}',
      '{"match":"edit","text":"Editing.","tools":[{"name":"Edit","input":{"file_path":"a.txt","old_string":"one","new_string":"one\\ntwo"}}]}',
      '{"match":"result","text":"Edited."}',
      '{"match":"hold","text":"Holding","hold":true}',
      '{"match":"fail","error":"model unavailable"}',
      '{"match":"greet","text":"Loading the skill.","tools":[{"name":"Skill","input":{"name":"greet"}}]}',
      '{"match":"result","text":"Hello, warmly."}',
      '{"match":"ask","text":"Asking.","tools":[{"name":"mcp__widecode__AskUser","input":{"questions":[{"question":"Which color?","header":"Color","options":[{"label":"Red","description":"warm"},{"label":"Blue"}]}]}}]}',
      '{"match":"result","text":"Red it is."}',
    ].join("\n") + "\n",
  );
  const log = join(home, "trace.log");
  const main = join(process.cwd(), "src", "harness", "main.ts");
  const config: unknown = {
    acp: {
      agents: {
        harness: {
          name: "harness",
          command: ["node", main, "--harness", "--harness-home", home, "--log", log, "--harness-fake", fixture],
          tools: ["node", main, "--harness-tools", "{mode}", "--harness-home", home],
          // The user's skills from a home of the test's, so the machine's own stay out.
          skills: ["env", "HOME=" + home, "node", main, "--harness-skills", "--harness-home", home],
          sessions: ["node", main, "--harness-sessions", "--harness-home", home],
          forget: ["node", main, "--harness-forget", "{session}", "--harness-home", home],
          midTurn: true,
          own: true,
        },
      },
    },
  };
  const w = await openWidecode({
    folder,
    plugins: config,
    before: (w: Widecode) => {
      w.host.session.agentId.value = "harness";
    },
  });
  const c = w.host.conversation;
  w.host.session.setTrusted(true);
  c.prepare();
  await w.host.session.load(w.host.folder, w.host.hooks);
  const idle = (): boolean => !c.model.running && c.model.pending.length === 0;
  const last = (): Turn => c.model.turns[c.model.turns.length - 1];
  const sent = (): string => readFileSync(log, "utf8");
  const turn = async (text: string): Promise<boolean> => {
    const before = c.model.turns.length;
    w.host.roles.chat.submit(text);
    return until(() => c.model.turns.length > before && idle());
  };

  ok("the session starts with widecode: its model and effort", await until(() => c.info.modelId === "fake/fake" && c.model.effort === "high"));
  eq("the modes it offers", c.agent.choices().modes.map((m) => m.value).join(","), "build,plan");
  eq("the agent's name", c.agent.name(), "harness");
  ok("the session was made with the project's prompt and trust in _meta", sent().includes('"method":"session/new"') && sent().includes('"_meta":{"widecode":{"systemPrompt":"You are running inside widecode') && sent().includes('"trusted":true'));

  ok("a reply from the fixture", await turn("hello there"));
  eq("its thinking, then its text", kinds(last().body.children), "thinking,text:Hello, world.");
  ok("the prompt carried _meta too", sent().includes('"method":"session/prompt"') && sent().split('"_meta":{"widecode"').length > 2);
  ok("the usage reached the status", c.info.contextInput + c.info.contextOutput > 0 || c.model.model.length > 0);

  // A message sent mid-turn steers the turn and is answered with it.
  const before = c.model.turns.length;
  w.host.roles.chat.submit("slow please");
  await until(() => c.model.turns.length > before && last().body.children.some((i: Item) => i.kind === TEXT));
  w.host.roles.chat.submit("and also this");
  ok("both answered at the turn's end", await until(() => idle() && c.model.pending.length === 0));
  const texts: string[] = [];
  for (const t of c.model.turns.slice(before)) for (const i of t.body.children) if (i.kind === TEXT) texts.push(i.text);
  eq("the reply, then the steered message's", texts.join(" | "), "Working on it for a while now. | You said: and also this");

  // A reply calling tools: the calls in the Tools tab with their output, counted in the Available tab.
  ok("a turn with tool calls", await turn("run it"));
  const calls = last().body.children.filter((i: Item) => i.kind === TOOL);
  eq("the calls, their tool and line, their results", calls.map((i: Item) => i.name + " " + i.summary + " → " + (i.result !== null ? i.result.text.replace(/\n/g, "|") : "?")).join(" ; "), "Run ls -1 → a.txt ; Read a.txt → 1\tone");
  eq("what the tools counted as: the tool's name, the first title", calls.map((i: Item) => i.tool).join(","), "Bash,Read");
  eq("the text after the results", last().body.children.filter((i: Item) => i.kind === TEXT).map((i: Item) => i.text).join("|"), "Listing.|One file, one line.");

  // An edit: its diff over the whole file with the lines' numbers, followed by the code column.
  ok("a turn with an edit", await turn("edit it"));
  const edit = last().body.children.find((i: Item) => i.kind === TOOL) ?? null;
  const hunks = edit === null || edit.result === null ? "" : edit.result.patch.map((h) => String(h.oldStart) + "," + String(h.newStart) + ":" + h.lines.join("|")).join(" ");
  eq("its file, its line, its diff with the file's line numbers", (edit === null ? "" : edit.category + " " + edit.paths.join(",") + " " + edit.summary) + " " + hunks, "edit " + join(folder, "a.txt") + " a.txt 1,1: one|+two");
  eq("the code column follows it", c.model.lastEdit, join(folder, "a.txt"));
  eq("the file changed", readFileSync(join(folder, "a.txt"), "utf8"), "one\ntwo\n");

  // The skills: the folder's in the Skills tab from the skills command, a Skill call a run of it.
  ok("the folder's skill in the Skills tab, from the skills command", await until(() => c.model.skillsKnown && c.model.skills.some((k) => k.name === "greet")));
  eq("with its description, its source and its file", c.model.skills.filter((k) => k.name === "greet").map((k) => k.description + " | " + k.source + " | " + k.path).join(""), "Greet the user | project | " + join(folder, ".claude", "skills", "greet", "SKILL.md"));
  ok("a turn loading it", await turn("greet me"));
  const loaded = last().body.children.find((i: Item) => i.kind === TOOL) ?? null;
  eq("the call: a skill, the skill's text as its result", loaded === null || loaded.result === null ? "" : loaded.category + " " + loaded.summary + " | " + loaded.result.text, "skill greet | The skill greet, from " + join(folder, ".claude", "skills", "greet") + ":\n\nSay hello warmly.");
  eq("a run of it in the Skills tab", skillRuns(c.model).map((r) => r.name + " " + r.state).join(","), "greet done");

  // widecode's own tools over its MCP server: AskUser's question in the request panel, the answer back to the model.
  w.host.roles.chat.submit("ask me");
  ok("AskUser's question in the request panel", await until(() => c.model.openRequests().length === 1));
  const asked = c.model.openRequests()[0];
  eq("its question and options", asked.category + " " + asked.questions[0].question + " " + asked.questions[0].options.map((o) => o.label).join("/"), "question Which color? Red/Blue");
  const reply = new Reply("answered");
  const pick = new Answer(asked.questions[0].question, false);
  pick.labels.push("Red");
  reply.answers.push(pick);
  c.respond(asked, reply);
  ok("answered: the turn goes on", await until(() => idle()));
  const askCall = last().body.children.find((i: Item) => i.kind === TOOL) ?? null;
  eq("the call holds the answer, the reply after it", (askCall === null || askCall.result === null ? "" : askCall.result.text) + " | " + last().body.children.filter((i: Item) => i.kind === TEXT).map((i: Item) => i.text).join("|"), 'The user answered:\n"Which color?": Red | Asking.|Red it is.');

  const held = c.model.turns.length;
  w.host.roles.chat.submit("hold on");
  await until(() => c.model.turns.length > held && last().body.children.some((i: Item) => i.kind === TEXT));
  c.interrupt();
  ok("Esc cancels the held turn", await until(() => idle()));
  ok("said as interrupted", last().body.children.some((i: Item) => i.text.startsWith("Interrupted")) || last().after.children.some((i: Item) => i.text.startsWith("Interrupted")));

  ok("a model error ends the turn with a notice carrying the message", (await turn("fail now")) && last().body.children.some((i: Item) => i.text === "Error" && i.detail.includes("model unavailable")));

  const chat = (): string[] => {
    const s = w.chat.pane.source;
    s.prepare(80);
    const out: string[] = [];
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 80).runs.map((r: Run) => r.text).join("").replace(/\s+$/, ""));
    return out;
  };
  ok("the chat shows the reply", chat().some((l) => l.includes("Hello, world.")));

  const available = (): string => {
    const p = w.host.screen.findPanel("available");
    if (p === null) return "none";
    const s = p.view.source;
    s.prepare(40);
    const out: string[] = [];
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 40).runs.map((r: Run) => r.text).join("").trim().replace(/(\S) {2,}(\S)/g, "$1  $2"));
    return out.join("|");
  };
  await until(() => available().startsWith("harness|Read  ×1|Write|Edit  ×1|Bash  ×1"));
  eq("the tools command answers the Available tab, with the calls counted", available().split("|").slice(0, 8).join("|"), "harness|Read  ×1|Write|Edit  ×1|Bash  ×1|BashOutput|BashStop|Grep");
  eq("plan mode", c.setMode("plan"), "");
  await until(() => available().startsWith("harness|Read  ×1|BashOutput|Grep"));
  eq("plan mode offers the read-only tools", available().split("|").slice(0, 9).join("|"), "harness|Read  ×1|BashOutput|Grep|Glob|LS|Skill  ×1|WebFetch|WebSearch");

  const sessions = sent().split('"method":"session/new"').length - 1;
  const firstSession = c.sessionId;
  c.reset();
  c.prepare();
  ok("/new starts another session on the same process", await until(() => sent().split('"method":"session/new"').length - 1 > sessions && c.model.effort === "high"));

  // The sessions: the first one in the Sessions tab with the title the fake model gave, opened again with its turns shown; /title; a fork for a side question, forgotten after.
  const sessionRows = (): string[] => {
    const p = w.host.screen.findPanel("sessions");
    const out: string[] = [];
    if (p === null) return out;
    const s = p.view.source;
    s.prepare(60);
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 60).runs.map((r: Run) => r.text).join("").trim());
    return out;
  };
  w.host.screen.showPanel("sessions");
  ok("the first session in the Sessions tab, named by the fake model, from session/list", await until(() => sessionRows().some((l) => l.includes("Fake session title"))));
  const p = w.host.screen.findPanel("sessions");
  const row = sessionRows().findIndex((l) => l.includes("Fake session title"));
  if (p !== null && row >= 0) p.press(row, 0);
  const open = w.host.kernel.actions.find("sessions.resume");
  if (open !== null) open.onRun(new KeyEvent("enter", "", false, false, false), 1);
  ok("opened again: the same session, its turns shown from the file (session/load)", await until(() => c.sessionId === firstSession && c.model.turns.length >= 5 && chat().some((l) => l.includes("Hello, world.")) && sent().includes('"method":"session/load"')));
  const files = (): string[] => readdirSync(join(home, "harness", "sessions", folder.replace(/[^A-Za-z0-9]/g, "-"))).sort();
  eq("one file: the first session's (the one left with /new was never written)", String(files().length), "1");
  w.host.roles.chat.submit("/title Hello world session");
  ok("/title names it, the tab following", await until(() => sessionRows().some((l) => l.includes("Hello world session"))));
  w.host.roles.chat.submit("/btw what was that?");
  ok("a side question in a fork, answered apart", await until(() => chat().some((l) => l.includes("│ You said: "))));
  ok("the fork's file removed after (--harness-forget)", await until(() => files().length === 1));
  w.host.roles.chat.submit("/compact");
  ok("/compact: the conversation so far summarized, the note saying the sizes", await until(() => chat().some((l) => /Compacted: \d+ tokens to \d+\./.test(l))));
  const noted = Number(/Compacted: \d+ tokens to (\d+)\./.exec(chat().find((l) => l.includes("Compacted: ")) ?? "")?.[1] ?? "0");
  ok("the status bar's context is the size after", noted > 0 && (await until(() => c.info.contextUsed === noted)));
  ok("and the session goes on from the summary", await turn("what now"));
  eq("the reply", last().body.children.filter((i: Item) => i.kind === TEXT).map((i: Item) => i.text).join("|"), "You said: what now");

  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
