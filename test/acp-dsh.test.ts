// ffi: @lightstart/plugins/native/ffi.json
// The DeepSeek Harness (`dsh`, --agent dsh) as an ACP agent (plugins/acp/index.ts), here the fake
// (test/fake-acp.mjs --dsh): it advertises session/list and session/resume but no session/load, no
// fork and no modes, and its session's config options are `model` (category `model`, opaque
// ["provider","model"] values) and `reasoning_effort` (category `thought_level`). widecode's own
// tools still reach it (mcpCapabilities.http). A process that ends is started again on the same
// session with session/resume (never session/load), and a past session pressed in the Sessions tab
// is resumed without replaying its turns, with a notice saying so. A plan mode it does not offer is
// refused.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Item, NOTICE, TEXT, THINKING, TOOL, Turn } from "../src/conversation/model.ts";
import type { Widecode } from "../src/compose.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";

const kinds = (items: Item[]): string => items.map((i: Item) => (i.kind === THINKING ? "thinking" : i.kind === TEXT ? "text" : i.kind === TOOL ? "tool" : i.kind === NOTICE ? "notice:" + i.text : "other")).join(",");

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-deepseek-"));
  writeFileSync(join(folder, "a.txt"), "one\n");
  const log = join(folder, "deepseek.log");
  const fake = join(process.cwd(), "test/fake-acp.mjs");
  const w = await openWidecode({
    folder,
    plugins: {
      models: { agents: { dsh: ['["deepseek-official","deepseek-flash"]', '["deepseek-official","deepseek-v4-pro"]'] } },
      acp: { agents: { dsh: { name: "DeepSeek Harness", command: ["node", fake, "--dsh", "--log", log] } } },
    },
    before: (w: Widecode) => {
      w.host.session.agentId.value = "dsh";
    },
  });
  const c = w.host.conversation;
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
  const turn = async (text: string): Promise<boolean> => {
    const before = c.model.turns.length;
    w.host.roles.chat.submit(text);
    return until(() => c.model.turns.length > before && idle());
  };
  const sessionRows = (): string[] => {
    const p = w.host.screen.findPanel("sessions");
    const out: string[] = [];
    if (p === null) return out;
    const s = p.view.source;
    s.prepare(60);
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 60).runs.map((r: Run) => r.text).join("").trim());
    return out;
  };
  const pressSession = (text: string): void => {
    const p = w.host.screen.findPanel("sessions");
    const at = sessionRows().findIndex((l: string) => l.includes(text));
    if (p !== null && at >= 0) p.press(at, 0);
    const open = w.host.kernel.actions.find("sessions.resume");
    if (open !== null) open.onRun(new KeyEvent("enter", "", false, false, false), 1);
  };

  eq("the DeepSeek Harness agent, not opencode", c.agent.id() + " " + c.agent.name(), "dsh DeepSeek Harness");
  ok("its session starts with widecode, model and effort known before any message", (await until(() => c.info.modelId === '["deepseek-official","deepseek-flash"]')) && c.started && sent().includes('"method":"session/new"') && !sent().includes('"method":"session/prompt"'));
  eq("the model's opaque value and its efforts (the provider default is the empty value)", c.info.modelId + " " + c.agent.choices().efforts.map((e) => e.value).join(","), '["deepseek-official","deepseek-flash"] ,off,low,high,max');
  ok("widecode's MCP tools are offered to it (it takes HTTP)", sent().includes('"name":"widecode"'));
  ok("it does not claim session/load, fork or modes", !sent().includes("session/load"));

  ok("a turn", await turn("hello"));
  ok("the prompt, and the reply", chat().some((l: string) => l.includes("<Me>: hello")) && chat().some((l: string) => l.includes("Hello, world.")));
  eq("thinking, then text", kinds(last().body.children), "thinking,text");
  const r = last().result;
  eq("the session ends end_turn", r === null ? "none" : r.subtype + " " + String(r.isError), "end_turn false");

  c.setEffort("low");
  ok("an effort it has goes as reasoning_effort", (await until(() => c.info.effort === "low")) && sent().includes('"method":"session/set_config_option","params":{"sessionId":"fake-1","configId":"reasoning_effort","value":"low"}'));
  const pro = '["deepseek-official","deepseek-v4-pro"]';
  c.setModel(pro);
  ok("another model of its provider group", (await until(() => c.info.modelId === pro)) && sent().includes('"configId":"model","value":"[\\"deepseek-official\\",\\"deepseek-v4-pro\\"]"'));

  // A process that ends, then the next message: the same session, resumed (never loaded).
  ok("its process ends mid-turn", await turn("exit"));
  ok("the turn ends with it", last().result !== null && last().result?.isError === true && !c.started);
  ok("the next message starts it again on the same session", await turn("hello"));
  const resumes = sent().split("\n").filter((l: string) => l.includes('"method":"session/resume"'));
  ok("resumed with session/resume, not session/load", c.started && c.sessionId === "fake-1" && resumes.length === 1 && resumes[0].includes('"sessionId":"fake-1"') && !sent().includes('"method":"session/load"') && kinds(last().body.children) === "thinking,text");

  // A past session pressed in the tab: reopened without replay, and said so.
  w.host.screen.showPanel("sessions");
  ok("its sessions listed from the agent", await until(() => sessionRows().includes("An earlier session")));
  pressSession("An earlier session");
  ok("resumed without replaying its turns, with a notice", await until(() => !c.model.running && c.model.lastNoticeIs("DeepSeek Harness resumed the session; its earlier turns are not shown")));
  const past = sent().split("\n").filter((l: string) => l.includes('"method":"session/resume"') && l.includes('"sessionId":"past-1"'));
  ok("session/resume for it too, and no replayed exchange", past.length === 1 && !chat().includes("earlier answer"));

  c.reset();
  ok("/new: a new session on the next message", (await turn("hello")) && c.sessionId === "fake-2");

  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
