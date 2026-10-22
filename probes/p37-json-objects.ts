// Parsed objects kept alive make later allocations slower natively. Parsing a real 4 MB transcript
// window (1597 records) took 9 ms when each result was dropped, but 267 ms when every result was
// kept in an array, growing with the live set (the first 800 records in 10 ms, the next 400 in
// 49 ms), and 573 ms for a second pass with the first set still alive; node took 18 ms either way.
// This probe parses 2000 records shaped like Claude Code's assistant lines, dropped and kept, and
// prints the times (stderr). The chat therefore keeps transcript lines as text and parses each one
// only while it is applied (apps/widecode/src/claude/chat/history.ts, claude/conversation.ts).
const record = (i: number): string =>
  JSON.stringify({
    parentUuid: "p" + String(i),
    isSidechain: false,
    message: {
      model: "claude-opus-5-5",
      id: "msg_" + String(i),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Some answer text number " + String(i) }],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 18831,
        cache_read_input_tokens: 24766,
        output_tokens: 1283,
        output_tokens_details: { thinking_tokens: 922 },
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: "standard",
        cache_creation: { ephemeral_1h_input_tokens: 18831, ephemeral_5m_input_tokens: 0 },
        iterations: [{ input_tokens: 2, output_tokens: 1283, cache_read_input_tokens: 24766, cache_creation_input_tokens: 18831, type: "message" }],
        speed: "standard",
      },
    },
    apiBlockIndex: 0,
    type: "assistant",
    uuid: "u" + String(i),
    timestamp: "2026-10-08T14:52:11.155Z",
    sessionId: "eefcb772-f43d-4d6f-a817-8472946b4b36",
    cwd: "/home/alanleal/Projects/bootstrapp",
  });

const lines: string[] = [];
let bytes = 0;
for (let i = 0; i < 2000; i++) {
  const l = record(i);
  lines.push(l);
  bytes += l.length;
}
let t0 = Date.now();
let n = 0;
for (const l of lines) {
  const v = JSON.parse(l) as { type?: unknown };
  if (v.type === "assistant") n++;
}
const dropped = Date.now() - t0;
t0 = Date.now();
const kept: unknown[] = [];
for (const l of lines) kept.push(JSON.parse(l));
const retained = Date.now() - t0;
console.log("parsed " + String(n) + " records, " + String(Math.round(bytes / 1024)) + " KB; kept " + String(kept.length));
process.stderr.write("2000 object-heavy records: " + String(dropped) + " ms dropped, " + String(retained) + " ms kept\n");
