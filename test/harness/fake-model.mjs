#!/usr/bin/env node
/**
 * @file A stand-in for the Anthropic Messages API in tests: an HTTP server on 127.0.0.1 at a free
 * port (printed as `PORT <n>` on stdout) answering `POST /v1/messages` (and a chat completions API's
 * `POST /v1/chat/completions`, the records holding its chunks) from a JSONL fixture, one
 * record per request in order: `{"status": 200, "sse": "<event text>", "delayMs": 0, "hold": false}`.
 * A 200 answers as an event stream, the events (blank-line separated in `sse`) written `delayMs`
 * apart; `hold` keeps the stream open until the client goes; another status writes the record's
 * `body`. Every request's body is appended to `--log` as one line, so a test can read what the
 * client sent. With the fixture used up, a request answers a one-line text reply "ok".
 */
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";

const at = process.argv.indexOf("--fixture");
const records = at >= 0 ? readFileSync(process.argv[at + 1], "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l)) : [];
const logAt = process.argv.indexOf("--log");
const log = logAt >= 0 ? process.argv[logAt + 1] : "";
let index = 0;

const DEFAULT = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":5,"output_tokens":1}}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
].join("\n\n");

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c.toString("utf8");
  });
  req.on("end", () => {
    if (log.length > 0) appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }) + "\n");
    if (req.method !== "POST" || (req.url !== "/v1/messages" && req.url !== "/v1/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":{"type":"not_found_error","message":"no such route"}}');
      return;
    }
    const r = index < records.length ? records[index++] : { status: 200, sse: DEFAULT };
    const status = r.status ?? 200;
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(r.body ?? '{"error":{"type":"api_error","message":"fixture error"}}');
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const events = String(r.sse ?? DEFAULT).split("\n\n");
    const delay = r.delayMs ?? 0;
    let i = 0;
    const next = () => {
      if (i >= events.length) {
        if (!r.hold) res.end();
        return;
      }
      res.write(events[i++] + "\n\n");
      if (delay > 0) setTimeout(next, delay);
      else next();
    };
    next();
    // A held stream stays open until the client goes (its socket closes); the request's own
    // "close", which fires once its body is read, must not end it.
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("PORT " + String(server.address().port) + "\n");
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
