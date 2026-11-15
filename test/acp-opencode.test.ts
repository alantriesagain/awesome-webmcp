// ffi: @lightstart/plugins/native/ffi.json
// opencode 1.19's own traffic through the acp plugin: its recording
// (test/fixtures/acp-opencode.ndjson, made by test/probe/acp.mjs on a free model)
// replayed by the fake. A reply and its thinking; a run call (its line the command, its output);
// a read and an edit (the diff with the file's line numbers), the code column following the edit;
// a cancel during a long command; the model and context it reports. Then a new process loads the
// session: the four turns again, as opencode replays them. The conversation's invariants hold
// (test/chat-invariants.ts).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { Item, NOTICE, TEXT, THINKING, TOOL, Turn } from "../src/conversation/model.ts";
import { RenderContext } from "../src/conversation/render.ts";
import { NoStateFile } from "@lightstart/kernel/settings.ts";
import { openWorkspace } from "@lightstart/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";
import { chatProblems } from "./support/chat-invariants.ts";

const kinds = (items: Item[]): string => items.map((i: Item) => (i.kind === THINKING ? "thinking" : i.kind === TEXT ? "text" : i.kind === TOOL ? "tool:" + i.name : i.kind === NOTICE ? "notice:" + i.text : "other")).join(",");

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-acp-opencode-"));
  writeFileSync(join(folder, "notes.txt"), "alpha\nBETA\ngamma\n");
  const log = join(folder, "replay.log");
  const fake = join(process.cwd(), "test/fake-acp.mjs");
  const fixture = join(process.cwd(), "test/fixtures/acp-opencode.ndjson");
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  // The model the recording chose, so the plugin chooses it too.
  c.modelName = "opencode/big-pickle";
  const w = composeWidecode(ws, c);
  w.host.session.agentId.value = "opencode";
  const config: unknown = { acp: { agents: { opencode: { name: "opencode", command: ["node", fake, "--replay", fixture, "--log", log] } } } };
  w.start(config, new NoStateFile(), []);
  await w.host.load();
  const idle = (): boolean => !c.model.running && c.model.pending.length === 0;
  const last = (): Turn => c.model.turns[c.model.turns.length - 1];
  const chat = (): string[] => {
    const s = w.chat.pane.source;
    s.prepare(80);
    const out: string[] = [];
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 80).runs.map((r: Run) => r.text).join("").replace(/\s+$/, ""));
    return out;
  };
  const turn = async (text: string): Promise<boolean> => {
    const before = c.model.turns.length;
    w.host.roles.chat.submit(text);
    return until(() => c.model.turns.length > before && idle());
  };
  /** The call named `name` in the last turn, null for none. */
  const callIn = (t: Turn, name: string): Item | null => t.body.children.find((i: Item) => i.kind === TOOL && i.name === name) ?? null;
  eq("the section's entry in place of the default", c.agent.id() + " " + c.agent.name(), "opencode opencode");

  ok("a turn", await turn("Reply with exactly the word PONG and nothing else."));
  eq("its thinking, then its reply", kinds(last().body.children) + " " + (last().body.children[1]?.text ?? ""), "thinking,text PONG");
  ok("on screen", await until(() => chat().some((l: string) => l.includes("PONG"))));
  eq("the model it runs on, its context", c.info.modelId + " " + String(c.info.contextSize), "opencode/big-pickle 200000");
  ok("the context used", c.info.contextUsed > 10000);

  ok("a run call", await turn("Use the bash tool to run exactly: ls -1. Then say done."));
  const run = callIn(last(), "Run");
  eq("its kind, line, command and output, no file", run === null || run.result === null ? "" : [run.category, run.summary, run.command, run.result.text.trim(), String(run.paths.length)].join(" | "), "run | ls -1 | ls -1 | notes.txt | 0");
  eq("then its reply", kinds(last().body.children), "thinking,tool:Run,thinking,text");

  ok("an edit", await turn("Use the edit tool to change the line beta to BETA in notes.txt. Then say done."));
  const read = callIn(last(), "Read");
  eq("a read first", read === null ? "" : read.category + " " + read.summary + " " + read.paths.join(","), "read notes.txt " + join(folder, "notes.txt"));
  const edit = callIn(last(), "Edit");
  const hunks = edit === null || edit.result === null ? "" : edit.result.patch.map((h) => String(h.oldStart) + "," + String(h.newStart) + ":" + h.lines.join("|")).join(" ");
  eq("the edit, its diff with the file's line numbers", (edit === null ? "" : edit.category + " " + edit.summary) + " " + hunks, "edit notes.txt 1,1: alpha|-beta|+BETA| gamma");
  eq("the code column follows it", c.model.lastEdit, join(folder, "notes.txt"));

  w.host.roles.chat.submit("Use the bash tool to run exactly: sleep 30. Then say done.");
  ok("a long command runs", await until(() => last().body.children.some((i: Item) => i.kind === TOOL && i.command === "sleep 30")));
  c.interrupt();
  ok("Esc cancels it", await until(() => idle()));
  eq("the turn ends cancelled", kinds(last().body.children).endsWith("notice:Interrupted") + " " + (last().result?.subtype ?? ""), "true cancelled");
  ok("the context kept (a cancel reports none used)", c.info.contextUsed > 10000);
  const id = c.sessionId;
  ok("the session opencode named", id.startsWith("ses_"));

  // A new process loads the session.
  c.kill();
  ok("its process ends", await until(() => !c.started));
  c.resume(id, "PONG");
  ok("loaded", await until(() => c.model.turns.length === 4 && c.started && idle()));
  eq("the prompts", c.model.turns.map((t: Turn) => (t.prompt?.text ?? "").slice(0, 28)).join(" / "), "Reply with exactly the word  / Use the bash tool to run exa / Use the edit tool to change  / Use the bash tool to run exa");
  eq("each turn's thinking, calls and replies", c.model.turns.map((t: Turn) => kinds(t.body.children)).join(" / "), "thinking,text / thinking,tool:Run,thinking,text / thinking,tool:Read,thinking,tool:Edit,thinking,text / thinking,tool:Run");
  const loadedEdit = callIn(c.model.turns[2], "Edit");
  eq("the calls whole", loadedEdit === null || loadedEdit.result === null ? "" : loadedEdit.summary + " " + String(loadedEdit.result.patch.length), "notes.txt 1");
  const ctx = new RenderContext();
  ctx.agent = "opencode";
  ctx.folder = folder;
  eq("the conversation's invariants", chatProblems(c.model, ctx, [40, 80, 120]).join("; "), "");

  w.host.kernel.stop();
  w.js.killProcesses();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
