#!/usr/bin/env node
/**
 * @file A stand-in for `claude -p` in tests: replays a recorded fixture
 * (`{"dir":"out"|"in","raw":"<line>"}` per line). It writes each "out" line to stdout; at each
 * "in" line it waits for one line on stdin and checks it has the recorded `type` (and, for a
 * `control_response`, the recorded request id); a mismatch exits 3 with a note on stderr. After
 * the last record it waits for stdin to close and exits 0. Every CLI flag is ignored except
 * `--fixture <path>`, `--strict` (a control response must also match the recorded body) and
 * `--record-args <path>` (its arguments are written there, one per line).
 *
 * Two control requests it answers itself, as Claude Code 2.1 does, outside the recording:
 * `cancel_async_message` drops a user message still waiting on stdin (one the recording has not
 * read yet, as the CLI's queue holds it) and answers `cancelled` true, else false;
 * `side_question` answers "Side answer to: <question>", with how many earlier ones it was given.
 */
import { readFileSync, writeFileSync } from "node:fs";

const record = process.argv.indexOf("--record-args");
if (record >= 0) writeFileSync(process.argv[record + 1], process.argv.slice(2).join("\n") + "\n");

const at = process.argv.indexOf("--fixture");
if (at < 0) {
  process.stderr.write("fake-claude: --fixture <path> is required\n");
  process.exit(2);
}
const records = readFileSync(process.argv[at + 1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
/** With `--strict`, a control response must also carry the recorded response body. */
const strict = process.argv.includes("--strict");
let index = 0;
/** @type {string[]} */
const queued = [];
/** @type {((line: string) => void) | null} */
let waiting = null;
let buffer = "";
let closed = false;

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    if (answered(line)) continue;
    if (waiting) {
      const fn = waiting;
      waiting = null;
      fn(line);
    } else queued.push(line);
  }
});
process.stdin.on("end", () => {
  closed = true;
  if (waiting) {
    process.stderr.write(`fake-claude: stdin closed while waiting for record ${index}\n`);
    process.exit(4);
  }
  if (index >= records.length) process.exit(0);
});

/** A control request the fake answers itself (cancel_async_message, side_question): answered, true. */
const answered = (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return false;
  }
  const subtype = m.type === "control_request" ? m.request?.subtype : "";
  const reply = (response) => process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } }) + "\n");
  if (subtype === "cancel_async_message") {
    const at = queued.findIndex((l) => {
      try {
        return JSON.parse(l).uuid === m.request.message_uuid;
      } catch {
        return false;
      }
    });
    if (at >= 0) queued.splice(at, 1);
    reply({ cancelled: at >= 0 });
    return true;
  }
  if (subtype === "side_question") {
    const history = m.request.history ?? [];
    setTimeout(() => reply({ response: "Side answer to: " + m.request.question + (history.length > 0 ? " (after " + history.length + ")" : ""), synthetic: false }), 50);
    return true;
  }
  return false;
};

const nextInput = () =>
  new Promise((resolve) => {
    if (queued.length > 0) resolve(queued.shift());
    else waiting = resolve;
  });

/** @param {any} expected @param {any} actual */
const matches = (expected, actual) => {
  if (expected.type !== actual.type) return false;
  if (expected.type === "control_response")
    return expected.response?.request_id === actual.response?.request_id && (!strict || JSON.stringify(expected.response?.response) === JSON.stringify(actual.response?.response));
  if (expected.type === "control_request") return expected.request?.subtype === actual.request?.subtype;
  return true;
};

for (; index < records.length; index++) {
  const r = records[index];
  if (r.dir === "out") {
    process.stdout.write(r.raw + "\n");
    continue;
  }
  const line = /** @type {string} */ (await nextInput());
  const expected = JSON.parse(r.raw);
  const actual = JSON.parse(line);
  if (!matches(expected, actual)) {
    process.stderr.write(`fake-claude: record ${index} expected ${r.raw.slice(0, 160)}\n  got ${line.slice(0, 160)}\n`);
    process.exit(3);
  }
}
if (closed) process.exit(0);
