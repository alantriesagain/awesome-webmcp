// The TUI parses Claude's stdout in-process. What does native JSON.parse cost for the large lines
// (an Edit result carrying the whole original file, 5 MB) and for a burst of small stream events?
// Prints sizes and field checks (same under node and natively) and timings (to stderr).
interface ToolResultLine {
  type?: string;
  message?: { content?: unknown };
  tool_use_result?: { filePath?: string; originalFile?: string; structuredPatch?: unknown };
}
interface DeltaLine {
  type?: string;
  event?: { type?: string; index?: number; delta?: { type?: string; text?: string } };
}

const parts: string[] = [];
for (let i = 0; i < 110000; i++) parts.push("const line" + String(i) + " = \"value with \\\"quotes\\\" and ✓\";\n");
const original = parts.join("");
const big = JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "The file was updated." }] },
  tool_use_result: { filePath: "/x/a.ts", oldString: "a", newString: "b", originalFile: original, structuredPatch: [{ oldStart: 1, lines: ["-a", "+b"] }] },
});
console.log("big line bytes > 5 MB: " + String(Buffer.byteLength(big) > 5 * 1024 * 1024));

let t0 = Date.now();
const r = JSON.parse(big) as ToolResultLine;
const bigMs = Date.now() - t0;
const tur = r.tool_use_result;
console.log("type " + String(r.type) + ", file " + (tur?.filePath ?? "") + ", original chars " + String(tur?.originalFile?.length ?? 0));

const small: string[] = [];
for (let i = 0; i < 5000; i++) small.push(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "word " + String(i) + " " } }, session_id: "11111111-2222-3333-4444-555555555555", parent_tool_use_id: null, uuid: "abcdef01-2345-6789-abcd-ef0123456789" }));
t0 = Date.now();
let text = "";
for (const line of small) {
  const d = JSON.parse(line) as DeltaLine;
  const delta = d.event?.delta;
  if (delta !== undefined && delta.type === "text_delta") text += delta.text ?? "";
}
const smallMs = Date.now() - t0;
console.log("5000 deltas joined: " + String(text.length) + " chars");
process.stderr.write("parse 5 MB line: " + String(bigMs) + " ms; 5000 delta lines: " + String(smallMs) + " ms\n");
