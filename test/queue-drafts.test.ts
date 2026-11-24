// ffi: @lightstart/plugins/native/ffi.json
// Drafts saved for later (plugins/queue/index.ts): /queue with the composer's text queues it and
// empties the composer, the Queue tab of the tools column lists it and its link's badge counts it;
// /queue with text queues that text; a press on a queued draft puts it back in the composer, takes
// it off the queue (the composer's own text, if any, taking its place) and focuses the chat; /queue
// with an empty composer says there is nothing to queue. Nothing is sent on its own.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Widecode } from "../src/compose.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

/** The Queue tab's rows at 40 cells, spaces trimmed at their end. */
const rowsOf = (w: Widecode): string[] => {
  const p = w.host.screen.findPanel("queue");
  if (p === null) return [];
  const s = p.view.source;
  s.prepare(40);
  const out: string[] = [];
  for (let i = 0; i < s.count(); i++) out.push(s.line(i, 40).runs.map((r: Run) => r.text).join("").replace(/\s+$/, ""));
  return out;
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-queue-drafts-"));
  const w = await openWidecode({ folder, load: true });
  const panel = w.host.screen.findPanel("queue");
  if (panel === null) {
    ok("the queue plugin mounted the Queue tab", false);
    done();
    return;
  }
  const input = w.chat.pane.input;
  const badge = (): string => panel.badge().map((r: Run) => r.text).join("");
  const info = (): string => panel.info().map((r: Run) => r.text).join("");
  const tell = (): string => w.host.screen.message.peek();

  // /queue with the composer's text: queued, and the composer cleared.
  w.chat.pane.composer.set(["first draft", "second line"], 1, 4);
  w.host.roles.chat.submit("/queue");
  eq("the composer's text queued, the composer cleared", String(input.isEmpty()) + " " + JSON.stringify(input.lines.join("|")), 'true ""');
  eq("the tab lists it as one clipped line, its badge counting it", rowsOf(w).join("|") + " " + badge() + " " + info(), " first draft second line 1  1 queued draft");
  eq("and the status bar says so", tell(), "queued a draft (1 waiting)");

  // /queue with text: that text, the composer left alone.
  w.chat.pane.composer.set(["keep me"], 0, 7);
  w.host.roles.chat.submit("/queue third draft");
  eq("text after /queue queued, the composer not touched", rowsOf(w).join("|") + " " + badge() + " " + input.value(), " first draft second line| third draft 2 keep me");
  eq("the count follows", info(), " 2 queued drafts");

  // A press on a draft while the composer holds text: they swap, so nothing typed is lost.
  w.host.screen.focus("tools");
  panel.press(0, 0);
  eq(
    "the draft back in the composer, its caret at the end, the chat focused",
    [input.lines.join("|"), String(input.row), String(input.col), w.host.screen.active.peek()].join(" "),
    "first draft|second line 1 11 chat",
  );
  eq("the composer's text took the draft's place in the queue", rowsOf(w).join("|") + " " + badge(), " keep me| third draft 2");
  eq("and the status bar says so", tell(), "queued draft back in the composer; what was there took its place");

  // A press on a draft with the composer empty: back in the composer, off the queue.
  w.chat.pane.composer.set([""], 0, 0);
  w.host.screen.focus("tools");
  panel.press(0, 0);
  eq("the draft back in the composer", input.lines.join("|") + " " + w.host.screen.active.peek(), "keep me chat");
  eq("off the queue, its badge and info following", rowsOf(w).join("|") + " " + badge() + " " + info(), " third draft 1  1 queued draft");
  eq("and the status bar says where it went", tell(), "queued draft back in the composer");

  // /queue with an empty composer: nothing to queue.
  w.chat.pane.composer.set([""], 0, 0);
  w.host.roles.chat.submit("/queue");
  eq("an empty composer: told there is nothing to queue, the queue unchanged", tell() + " " + badge(), "nothing to queue 1");

  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
