// Server-sent events from text in any pieces: an event's name and data, data over several lines
// joined, a comment and an id skipped, CRLF taken, the last event flushed at the end.
import { SseEvent, SseSplitter } from "../src/harness/model/sse.ts";
import { done, eq } from "@light/test/assert.ts";

const s = new SseSplitter();
const show = (events: SseEvent[]): string => events.map((e) => e.event + "=" + e.data.replace(/\n/g, "\\n")).join(" | ");
eq("nothing until the blank line", show(s.push("event: message_start\ndata: {\"a\":1}\n")), "");
eq("the event at the blank line, then another split across pieces", show(s.push("\nevent: ping\ndata: {\"b")) + " / " + show(s.push("\":2}\n\n")), "message_start={\"a\":1} / ping={\"b\":2}");
eq("data lines joined, a comment and an id skipped, CRLF taken", show(s.push(": keep-alive\r\nid: 7\r\ndata: one\r\ndata: two\r\n\r\n")), "=one\\ntwo");
eq("the last event flushed without its blank line", show(s.push("event: message_stop\ndata: {}")) + " / " + show(s.flush()), " / message_stop={}");
eq("nothing more", show(s.flush()), "");
done();
