// ffi: @lightstart/plugins/native/ffi.json
// The conversation's invariants (test/chat-invariants.ts) over every recorded Claude Code session
// in test/fixtures, received by Claude Code's plugin as the chat test replays them
// and drawn at 40, 80 and 120 columns; and the model's own: a notice while idle opens no turn, a
// replayed notification of a background task never takes a queued message off the queue (a
// replayed message the user queued does), a result closes the turn.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatModel } from "../src/conversation/model.ts";
import { RenderContext } from "../src/conversation/render.ts";
import { closeLightcode, openLightcode } from "./support/app.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { chatProblems } from "./support/chat-invariants.ts";
import { contentText, rec, str } from "./support/claude-records.ts";
import { registerLanguages } from "@lightstart/highlight/languages.ts";

registerLanguages();

const fixtures = join(process.cwd(), "test", "fixtures");
const WIDTHS = [40, 80, 120];

interface Frame {
  dir?: unknown;
  raw?: unknown;
}

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "lightcode-invariants-"));
  const w = await openLightcode({ folder });
  const c = w.host.conversation;
  const receive = (o: unknown): void => c.receive(JSON.stringify(o));

  /** A fixture's traffic through Claude Code's plugin: what the CLI wrote, and the messages sent queued as the app queues them. */
  const replay = (name: string): ChatModel => {
    c.reset();
    const model = c.model;
    for (const line of readFileSync(join(fixtures, name), "utf8").split("\n")) {
      if (line.length === 0) continue;
      const f = JSON.parse(line) as Frame;
      let value: unknown = null;
      try {
        value = JSON.parse(str(f.raw));
      } catch {
        continue;
      }
      const r = rec(value);
      if (r === null) continue;
      if (str(f.dir) === "in") {
        if (str(r.type) === "user") {
          const m = rec(r.message);
          const got = contentText(m !== null ? m.content : null);
          model.send(got.text, got.images);
        }
        continue;
      }
      c.receive(str(f.raw));
    }
    return model;
  };

  const ctx = new RenderContext();
  ctx.agent = "Claude";
  const names = readdirSync(fixtures)
    .filter((f: string) => f.endsWith(".ndjson") && !f.startsWith("acp-"))
    .sort();
  ok("the recorded sessions", names.length > 10);
  for (const name of names) eq(name, chatProblems(replay(name), ctx, WIDTHS).join("; "), "");

  // The model's own.
  c.reset();
  const m = c.model;
  m.notice("a note while idle", "info", "", "");
  ok("a notice while idle opens no turn", !m.running && m.current === null && m.turns.length === 1 && m.turns[0].notes);
  m.send("queued one", 0);
  receive({
    type: "user",
    isReplay: true,
    message: { role: "user", content: "<task-notification><status>completed</status><summary>The task finished</summary></task-notification>" },
  });
  eq("a replayed notification takes no queued message", String(m.pending.length) + " " + (m.current !== null && m.current.prompt !== null ? m.current.prompt.tone + ": " + m.current.prompt.text : ""), "1 notice: The task finished");
  receive({ type: "user", isReplay: true, message: { role: "user", content: "queued one" } });
  eq("a replayed message the user queued does", String(m.pending.length) + " " + (m.current !== null && m.current.prompt !== null ? m.current.prompt.text : ""), "0 queued one");
  receive({ type: "result", subtype: "success", is_error: false, duration_ms: 1200, total_cost_usd: 0.01, result: "ok" });
  ok("a result closes the turn", !m.running && m.current === null);
  eq("and all of it holds", chatProblems(m, ctx, WIDTHS).join("; "), "");

  closeLightcode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
