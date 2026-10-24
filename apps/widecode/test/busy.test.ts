// ffi: @light/plugins/native/ffi.json
// The chat's line saying what Claude is doing, from recorded sessions: none while Claude is idle; a
// message sent while it is idle shows as sent at once (not queued), with "Sending…" under it and a
// clock that runs; the running tool while one runs, with its own clock and the turn's, a message
// sent meanwhile queued under that line; nothing once the turn ends, nor while Claude waits for the
// user's answer.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { contentText, rec, str } from "./support/claude-records.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { createWidecode } from "../src/compose.ts";
import { Run } from "@bootstrapp/light/native/tui/lines.ts";
import { done, eq, ok } from "@light/test/assert.ts";

interface Frame {
  dir?: unknown;
  raw?: unknown;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** The activity line without its spinner frame, or "" when there is none. */
const activity = (lines: string[]): string => {
  const l = lines.find((x) => x.length > 0 && SPINNER.includes(x[0]));
  return l !== undefined ? l.slice(2) : "";
};
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-busy-"));
  writeFileSync(join(folder, "a.txt"), "a\n");
  const ws = await openWorkspace(folder, 100);

  /** Replays a fixture into a fresh conversation, calling `at` after each record with the chat's lines. */
  const replay = (name: string, at: (record: string, lines: string[]) => void): void => {
    const c = new Conversation(ws.folder);
    const w = createWidecode(ws, c, null);
    const source = w.chat.pane.source;
    const chat = (): string[] => {
      source.prepare(80);
      const out: string[] = [];
      for (let i = 0; i < source.count(); i++) out.push(source.line(i, 80).runs.map((r: Run) => r.text).join("").replace(/\s+$/, ""));
      return out;
    };
    at("start", chat());
    for (const line of readFileSync(join(process.cwd(), "test", "fixtures", name + ".ndjson"), "utf8").split("\n")) {
      if (line.length === 0) continue;
      const f = JSON.parse(line) as Frame;
      if (typeof f.raw !== "string") continue;
      const r = rec(JSON.parse(f.raw));
      if (r === null) continue;
      let what = str(r.type);
      if (f.dir === "in") {
        if (what !== "user") continue;
        const m = rec(r.message);
        if (m !== null) c.model.send(contentText(m.content).text, 0);
        what = "sent";
      } else {
        c.receive(f.raw);
        const m = rec(r.message);
        const blocks = m !== null && Array.isArray(m.content) ? m.content : [];
        for (const b of blocks) {
          const block = rec(b);
          if (block !== null && str(block.type) === "tool_use") what += ":" + str(block.name);
        }
        if (r.isReplay === true) what += ":replay";
        if (what === "control_request") what += ":" + str(rec(r.request)?.tool_name);
      }
      at(what, chat());
    }
  };

  const seen = new Map<string, string[]>();
  let sent = 0;
  replay("midtool", (what: string, lines: string[]) => {
    if (what === "sent") sent++;
    const key = what === "sent" ? "sent" + String(sent) : what;
    if (!seen.has(key)) seen.set(key, lines);
  });
  const at = (key: string): string[] => seen.get(key) ?? [];
  eq("idle: no line says Claude is busy", activity(at("start")), "");
  const first = at("sent1");
  ok("a message sent while Claude is idle shows as sent at once", first.some((l) => l.startsWith("› Run the shell command")) && !first.some((l) => l.includes("queued")));
  eq("and under it, Claude is taking it", activity(first), "Sending… 0s");
  eq("the CLI's copy of it does not show it twice", String(at("user:replay").filter((l) => l.includes("<Me>: Run the shell command")).length), "1");
  eq("a tool running: what its command does", activity(at("assistant:Bash")), "Running Sleep for 6 seconds then echo S… 0s · turn 0s · Esc interrupts");
  const second = at("sent2");
  eq("a message sent meanwhile is queued under that line, with how to take it back", second.slice(-3).map((l) => (SPINNER.includes(l[0]) ? "activity" : l)).join(" | "), "activity | ⧗ queued: Also, at the end, say the word BANANA. |   ↑ in an empty composer takes it back to edit");
  eq("the turn over: nothing says Claude is busy", activity(at("result")), "");

  const asked = new Map<string, string[]>();
  replay("ask", (what: string, lines: string[]) => {
    if (!asked.has(what)) asked.set(what, lines);
  });
  ok("Claude about to ask: busy", activity(asked.get("assistant:AskUserQuestion") ?? []).length > 0);
  eq("waiting for the user's answer: not busy", activity(asked.get("control_request:AskUserQuestion") ?? []), "");

  // The clock runs from the moment the message was sent.
  const c = new Conversation(ws.folder);
  const w = createWidecode(ws, c, null);
  const source = w.chat.pane.source;
  c.model.send("hello", 0);
  source.prepare(80);
  await wait(1100);
  source.prepare(80);
  let line = "";
  for (let i = 0; i < source.count(); i++) {
    const t = source.line(i, 80).runs.map((r: Run) => r.text).join("");
    if (SPINNER.includes(t[0])) line = t.slice(2);
  }
  eq("a second later, its clock says so", line, "Sending… 1s");

  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
