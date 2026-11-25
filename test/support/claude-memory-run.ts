// The long Claude Code session behind test/claude-memory.test.ts: 1900 turns of transcript lines
// through the plugin, each turn carrying a record of 20 KiB the model does not keep (a status
// record's unused field): what the engine gains between the readings is the plugin's own raw lines. Run under node with --expose-gc (the engine's memory is
// the process heap here), so a collection before each reading leaves what is still held.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { closeLightcode, openLightcode } from "./app.ts";

const TURNS = 1900;
const MID = 1600;
const TOOL_BYTES = 20 * 1024;
const toolResult = "x".repeat(TOOL_BYTES);

const turn = (i: number): string[] => [
  JSON.stringify({ type: "user", uuid: "u" + String(i), message: { role: "user", content: "turn " + String(i) } }),
  JSON.stringify({ type: "assistant", message: { id: "m" + String(i), model: "claude-test", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "reply " + String(i) }] } }),
  JSON.stringify({ type: "system", subtype: "status", status: "requesting", junk: toolResult }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 1, total_cost_usd: 0.001, result: "done", usage: { output_tokens_details: { thinking_tokens: 0 } } }),
];

const main = async (): Promise<void> => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const folder = mkdtempSync(join(tmpdir(), "lightcode-claude-memory-"));
  // The session as a fixture, the shape fake-claude.mjs replays; its lines are fed below.
  const records: string[] = [];
  for (let i = 0; i < TURNS; i++) for (const l of turn(i)) records.push(JSON.stringify({ dir: "out", raw: l }));
  writeFileSync(join(folder, "long.jsonl"), records.join("\n") + "\n");
  records.length = 0;

  const app = await openLightcode({ folder });
  const c = app.host.conversation;
  const heap = (): number => {
    gc();
    return app.js.memoryBytes();
  };
  const before = heap();
  let mid = 0;
  for (let i = 0; i < TURNS; i++) {
    for (const l of turn(i)) c.receive(l);
    if (i + 1 === MID) mid = heap();
  }
  const end = heap();
  closeLightcode(app);
  rmSync(folder, { recursive: true, force: true });
  console.log("claude-memory: " + JSON.stringify({ turns: TURNS, mid, end, before }));
};

main().catch((err: unknown) => {
  console.log("claude-memory: FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
