// ffi: @lightstart/plugins/native/ffi.json
// The status tables (the status JS plugin) through the app, on a recorded session: the default
// table under the chat (the session: no branch, no calls; columns as wide as their widest cell so
// the rules line up, the meters stacked, each row's last cell growing and clipped with an ellipsis
// at the bar's edge, columns dropped before the text gets too little room) and the one under the
// tools column (what Claude is doing and for how long, its calls by kind, its thinking); no rule
// after an empty last cell; custom layouts from config.json
// (order and separator, a label, a list cell, a recolored segment and an unknown color ignored, a
// spacer, an unknown name shown as ?name, a column blank in every row left out); a press on a cell
// (the model's switches it, the mode's toggles plan mode); the previous default moved to the table;
// command segments: the status JSON on stdin and COLUMNS set, ANSI colors kept, a slow command
// stopped with a note, a failing one saying why.
import { readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsBand } from "../src/runtime/views.ts";
import type { Widecode } from "../src/compose.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { Line, Run } from "@lightstart/light/native/tui/lines.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
const textOf = (l: Line): string => l.runs.map((r) => r.text).join("").replace(/\s+$/, "");
const styled = (runs: Run[]): string => runs.map((r) => (r.fg.length > 0 || r.bold ? "[" + r.fg + (r.bold ? "b" : "") + (r.bg.length > 0 ? "/" + r.bg : "") + "]" : "") + r.text).join("");
/** Where a row's column rules are. */
const rules = (row: string): string => {
  const at: number[] = [];
  for (let i = 0; i < row.length; i++) if (row.charAt(i) === "│") at.push(i);
  return at.join(",");
};

interface Frame {
  dir?: unknown;
  raw?: unknown;
}

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "demo-"));
  /** widecode with `config`, a recorded session fed to it, and the session's status filled in. */
  const make = async (config: string): Promise<Widecode> => {
    const w = await openWidecode({ folder, plugins: JSON.parse(config) });
    const c = w.host.conversation;
    for (const line of readFileSync(join(process.cwd(), "test", "fixtures", "edit.ndjson"), "utf8").split("\n")) {
      if (line.length === 0) continue;
      const f = JSON.parse(line) as Frame;
      if (f.dir === "out" && typeof f.raw === "string") c.receive(f.raw);
    }
    c.title = "List file edits";
    c.effort = "low";
    w.host.conversationChanged.fire();
    c.info.branch = "main";
    c.info.costUsd = 0.0181;
    c.info.activity = "Bash npm test";
    return w;
  };
  const bandOf = (w: Widecode, id = "status"): JsBand | null => {
    for (const b of w.host.screen.band) if (b.id === id && b.view instanceof JsBand) return b.view;
    return null;
  };
  const draw = (w: Widecode, width: number, id = "status"): string[] => {
    const b = bandOf(w, id);
    return b !== null ? b.lines(width).map(textOf) : [];
  };

  let w = await make("{}");
  const table = draw(w, 164);
  eq("the default table: three rows", String(table.length), "3");
  ok("row 1: folder, context, cost, the title last", table[0].startsWith(" ◆ demo-") && table[0].replace(/ +/g, " ").endsWith("│ ctx ▰▱▱▱▱▱▱▱ 10% 21k/200k │ $0.02 │ List file edits"));
  ok("row 2: model and effort in one cell, the 5h limit, time, the key hints last", table[1].startsWith(" Haiku 4.5 · low │ 5h  ▱▱▱▱▱▱▱▱   5% ↻") && table[1].includes("Enter sends"));
  ok("row 3: the mode, the week, the cache", table[2].startsWith(" bypass ") && table[2].includes("│ wk  ▰▰▰▰▰▱▱▱  65% ↻") && table[2].includes("│ cache ● ") && table[2].endsWith(" 92% hit · 0 miss"));
  ok("no branch (the code column's strip has it), no calls (the tools column's)", !table.join("|").includes("main") && !table.join("|").includes("calls"));
  eq("the columns line up: every rule at the same place in every row", rules(table[1]), rules(table[0]));
  eq("and in the third", rules(table[2]).split(",").slice(0, 2).join(","), rules(table[0]).split(",").slice(0, 2).join(","));
  const meters = [table[0].indexOf("▰"), table[1].indexOf("▱"), table[2].indexOf("▰")];
  eq("the meters stack: their bars start in the same column", String(meters[1] === meters[0] && meters[2] === meters[0]), "true");
  eq("under the tools column: the running tool, its calls by kind, its thinking", draw(w, 60, "tools-status").join(" | "), " ↳ Bash npm test |  R 0 W 2 X 0 A 0 |  think 267");
  const info = w.host.conversation.info;
  info.activity = "thinking";
  info.activitySince = Date.now() - 3200;
  ok("while Claude thinks the activity cell says so, and for how long", draw(w, 60, "tools-status")[0] === " ✻ thinking… 3s");
  info.activitySince = 0;
  info.activity = "compacting";
  ok("and while Claude Code compacts the conversation", draw(w, 60, "tools-status")[0] === " ✻ compacting…");
  info.activity = "";
  eq("nothing running: an empty row", draw(w, 60, "tools-status")[0], "");
  w.host.conversation.info.title = "A title far longer than the room the bar has left for it at this width";
  const clipped = draw(w, 74);
  ok("a last cell longer than the bar ends in an ellipsis inside it", clipped[0].endsWith("…") && clipped.every((r) => r.length <= 70));
  ok("narrow: columns dropped before the text", !clipped[0].includes("cache"));
  closeWidecode(w);

  w = await make('{"status": {"separator": " · ", "lines": [["cost", "model"], [{"segment": "calls", "fg": "#ff0000", "label": "n"}, "spacer", "nope"]]}}');
  const custom = draw(w, 44);
  eq("a custom layout: its order and separator", custom[0], " $0.02 · Haiku 4.5");
  ok("a label, the spacer, an unknown name shown as ?name", custom[1].startsWith(" n 2 calls   ") && custom[1].endsWith("?nope") && custom[1].length === 39);
  const b = bandOf(w);
  const recolored = b !== null ? b.lines(44)[1].runs.filter((r) => r.text === "2" || r.text === " calls") : [];
  ok("a segment recolored", recolored.length === 2 && recolored.every((r) => r.fg === "#ff0000"));
  closeWidecode(w);
  w = await make('{"status": {"lines": [["cost", "activity"], ["cost", "calls"]]}}');
  w.host.conversation.info.activity = "";
  const quiet = draw(w, 84);
  eq("an empty last cell leaves no dangling rule", quiet[0] + " /" + quiet[1], " $0.02 / $0.02 │ 2 calls");
  closeWidecode(w);
  w = await make('{"status": {"lines": [["queued", "cost", "title"], ["queued", "calls", "note"]]}}');
  eq("a column blank in every row is left out", draw(w, 84).map((l) => l.replace(/ +$/, "")).join(" / ").replace(/│ [^/]*$/, "│ note"), " $0.02   │ List file edits /  2 calls │ note");
  closeWidecode(w);
  w = await make('{"status": {"lines": [[["cost", "calls", "queued"]], [{"segment": "cost", "fg": "salmon"}]]}}');
  const listed = draw(w, 84);
  eq("a list cell joins its segments", listed[0], " $0.02 · 2 calls");
  const salmon = bandOf(w);
  ok("an unknown color is ignored, not fatal", salmon !== null && salmon.lines(84)[1].runs.every((r) => r.fg !== "salmon"));
  closeWidecode(w);

  w = await make("{}");
  const pressed = bandOf(w);
  const row3 = draw(w, 164)[2];
  if (pressed !== null) pressed.pressAt(1, 2);
  eq("a press on the model cell switches the model", w.host.conversation.modelName, "fable[1m]");
  if (pressed !== null) pressed.pressAt(2, row3.indexOf("bypass") + 1);
  eq("a press on the mode toggles plan mode", w.host.conversation.model.permissionMode, "plan");
  closeWidecode(w);

  w = await make('{"status": {"separator": " │ ", "lines": [["project","branch","model","effort","mode","title","spacer","note"],["context","limit5h","limitWeek","cache"],["activity","tools","calls","thinking","cost","duration"]]}}');
  eq("the previous default becomes the table", rules(draw(w, 164)[0]).split(",").length >= 3 ? "table" : "old", "table");
  closeWidecode(w);
  w = await make('{"status": {"separator": " │ ", "lines": [["project", "context", "cache", "cost", "title"], ["branch", "limit5h", "tools", "duration", "activity"], [["model", "effort"], "limitWeek", ["calls", "thinking"], "mode", "note"]]}}');
  ok("an earlier default, as written, becomes the current one", draw(w, 164)[1].startsWith(" Haiku 4.5 · low │ 5h"));
  closeWidecode(w);
  w = await make('{"status": {"separator": " │ ", "lines": [["project", "context", "cache", "cost", "title"], ["branch", "limit5h", "tools", "duration", "activity"], [["model", "effort"], "limitWeek", "calls", "mode", "note"]]}}');
  ok("the last default, as written, too: no branch, no calls", draw(w, 164)[1].startsWith(" Haiku 4.5 · low │ 5h") && !draw(w, 164).join("|").includes("calls"));
  closeWidecode(w);

  const reader = JSON.stringify("calls=$(grep -o '\"calls\":[0-9]*'); printf '\\033[1;32m%s\\033[0m cols=%s\\nsecond line\\n' \"$calls\" \"$COLUMNS\"");
  w = await make('{"status": {"lines": [[{"command": ' + reader + '}], [{"command": "sleep 5"}], [{"command": "echo broken >&2; exit 3"}]]}}');
  // Drawn at 77 cells, then run again as the session changes: COLUMNS is the bar's width.
  draw(w, 77);
  await wait(400);
  w.host.conversationChanged.fire();
  await wait(2900);
  const cmd = bandOf(w);
  const out = cmd !== null ? cmd.lines(77) : [];
  eq("a command reads the JSON on stdin and prints colored lines, COLUMNS set", out.slice(0, 2).map((l) => styled(l.runs.slice(1))).join(" | "), '[2b]"calls":2 cols=77 | second line');
  ok("a slow one is stopped, with a note", out.length > 2 && textOf(out[2]).includes("took over 2 s"));
  ok("a failing one says why", out.length > 3 && textOf(out[3]).includes("status command exited 3: broken"));
  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
