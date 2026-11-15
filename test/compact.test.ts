// ffi: @light/plugins/native/ffi.json
// /compact, from a recorded session that compacted after one exchange: while Claude Code compacts,
// the activity says so and the chat's last line too (its spinner, what and how long), under /compact shown as sent; after, one notice says how much it freed, the
// summary it left is a notice opened on a press (not a prompt), its "Compacted" output is not
// repeated, and the context meter reads the summary's size at once. /help lists /compact.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityOf } from "../src/conversation/activity.ts";
import { Conversation } from "../src/conversation/conversation.ts";
import { contentText, rec, str } from "./support/claude-records.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { createWidecode } from "../src/compose.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { done, eq, ok } from "@light/test/assert.ts";

interface Frame {
  dir?: unknown;
  raw?: unknown;
}

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-compact-"));
  writeFileSync(join(folder, "a.txt"), "a\n");
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = createWidecode(ws, c, null);
  await w.host.load();

  const source = w.chat.pane.source;
  const chat = (): string[] => {
    source.prepare(80);
    const out: string[] = [];
    for (let i = 0; i < source.count(); i++) out.push(source.line(i, 80).runs.map((r: Run) => r.text).join("").replace(/\s+$/, ""));
    return out;
  };

  let during = "";
  let lastLine = "";
  let prompt = "";
  let before = 0;
  for (const line of readFileSync(join(process.cwd(), "test", "fixtures", "compact.ndjson"), "utf8").split("\n")) {
    if (line.length === 0) continue;
    const f = JSON.parse(line) as Frame;
    if (typeof f.raw !== "string") continue;
    const r = rec(JSON.parse(f.raw));
    if (f.dir === "in") {
      // What the user sent, queued as the app queues it.
      const m = r !== null && str(r.type) === "user" ? rec(r.message) : null;
      if (m !== null) c.model.send(contentText(m.content).text, 0);
      continue;
    }
    c.receive(f.raw);
    if (r !== null && str(r.subtype) === "status" && str(r.status) === "compacting") {
      during = activityOf(c.model);
      const lines = chat();
      lastLine = lines[lines.length - 1];
      prompt = lines.filter((l) => l.includes("<Me>: /compact") || l.includes("queued")).join(" | ");
      before = c.info.contextInput + c.info.contextCacheRead + c.info.contextCacheWrite;
    }
  }
  eq("while it compacts the activity says so", during, "compacting");
  eq("and the chat's last line, after its spinner", lastLine.slice(2).replace(/ \d+s /, " Ns "), "Compacting the conversation… Ns · Esc interrupts");
  ok("/compact shows as sent, not queued", prompt.includes("<Me>: /compact") && !prompt.includes("queued"));
  eq("done, it is quiet again", activityOf(c.model), "");

  const lines = chat();
  ok("one notice says how much it freed", lines.includes("· Conversation compacted · 19k → 2k tokens"));
  ok("the summary is a notice", lines.includes("· Summary of the earlier conversation"));
  ok("not a prompt", !lines.some((l) => l.includes("<Me>: This session is being continued")));
  ok("its \"Compacted\" is not repeated", !lines.some((l) => l.includes("Compacted")));
  ok("no line says it is still compacting", !lines.some((l) => l.includes("Compacting the conversation")));
  const after = c.info.contextInput + c.info.contextCacheRead + c.info.contextCacheWrite;
  eq("the context meter reads the summary's size", String(before) + " → " + String(after), "19369 → 1879");

  const cmd = w.host.kernel.commands.find("/compact");
  eq("/help lists /compact", cmd !== null ? cmd.usage + " · " + cmd.help : "", "[instructions] · summarize the conversation so far, freeing context");

  w.host.kernel.stop();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
