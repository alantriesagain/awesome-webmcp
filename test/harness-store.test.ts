// node-only
// A session's file: made on the first entry with its header, the entries appended one after the
// other, a load giving back the branch from the last entry, a change kept, a title read by the list
// through its tail, a fork copying the branch into a file of its own, a removed file made again by
// the next append, a file without a header or of another folder left out of the list.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message, Part, TOOL_CALL, TOOL_RESULT, textPart } from "../src/harness/model/message.ts";
import { Entry, MESSAGE, MODEL, TITLE } from "../src/harness/session/entries.ts";
import { SessionStore, sessionsJson } from "../src/harness/session/store.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const dir = mkdtempSync(join(tmpdir(), "harness-store-"));
const store = new SessionStore(join(dir, "sessions"));

const user = new Message("user", "u1");
user.parts.push(textPart("hello"));
const assistant = new Message("assistant", "m1");
const call = new Part(TOOL_CALL);
call.callId = "call_1";
call.name = "Read";
call.inputJson = '{"file_path":"a.txt"}';
assistant.parts.push(textPart("Reading."), call);
const results = new Message("user", "u2");
const result = new Part(TOOL_RESULT);
result.callId = "call_1";
result.text = "     1\tone";
result.acpJson = '{"kind":"read","text":"     1\\tone","isError":false,"locations":["/p/a.txt"]}';
results.parts.push(result);

const f = store.open("s1", "/p");
ok("nothing before the first entry", !existsSync(f.path()));
f.append(Entry.ofValue(MODEL, "", "fake/fake", 1000));
f.append(Entry.ofMessage(user, 1001));
f.append(Entry.ofMessage(assistant, 1002));
f.append(Entry.ofMessage(results, 1003));
f.append(Entry.ofValue(TITLE, "", "A hello", 1004));
const lines = readFileSync(f.path(), "utf8").split("\n");
eq("the header, then the entries, each following the last", lines.map((l) => (l.length > 0 ? (Entry.parse(l)?.kind ?? "?") + ":" + (Entry.parse(l)?.id ?? "") + "<" + (Entry.parse(l)?.parentId ?? "") : "")).join(" "), "session:s1< model:e1< message:u1<e1 message:m1<u1 message:u2<m1 title:e2<u2 ");
eq("the header's folder and time", lines[0], '{"kind":"session","id":"s1","parentId":"","at":1000,"cwd":"/p","version":1}');

const got = store.load("s1");
ok("a load gives the branch back", got !== null && got.entries.length === 5);
if (got !== null) {
  eq("the entries, oldest first", got.entries.map((e) => e.kind + ":" + e.id).join(","), "model:e1,message:u1,message:m1,message:u2,title:e2");
  const m = got.entries[2].message();
  eq("a message with its parts: the text, the call with its input", m.role + " " + m.id + " " + m.parts.map((p) => p.kind + (p.name.length > 0 ? ":" + p.name + ":" + p.inputJson : ":" + p.text)).join(" "), "assistant m1 text:Reading. tool_call:Read:{\"file_path\":\"a.txt\"}");
  eq("the result keeps the ACP facts of its call", got.entries[3].message().parts[0].acpJson, result.acpJson);
  eq("the file continues from the leaf with the next entry number", got.file.leaf + " " + got.file.nextId(), "e2 e3");
}

const listed = store.list("/p");
eq("the list: the session with its title", listed.map((s) => s.id + " " + s.title + " " + String(s.startedMs)).join(","), "s1 A hello 1000");
eq("another folder's list is empty", String(store.list("/q").length), "0");
ok("as JSON for the client", sessionsJson(listed).startsWith('[{"sessionId":"s1","cwd":"/p","title":"A hello","updatedAt":'));

const copy = store.fork("s1", "s2");
ok("a fork copies the branch into a file of its own, continued at its end", copy !== null && copy.leaf === "e2" && readFileSync(store.pathOf("s2"), "utf8").split("\n").length === 7);
if (copy !== null) {
  copy.append(Entry.ofValue(MODEL, "", "fake/other", 1005));
  eq("an entry of the copy has a number past the copied ones", copy.leaf, "e3");
}
ok("a fork of nothing", store.fork("s9", "s10") === null);

ok("removed", store.remove("s1") && !existsSync(store.pathOf("s1")) && !store.remove("s1"));
f.append(Entry.ofMessage(user, 2000));
ok("an append after the removal makes the file again, with its header", existsSync(f.path()) && readFileSync(f.path(), "utf8").startsWith('{"kind":"session","id":"s1"'));

writeFileSync(store.pathOf("junk"), "not json\n");
writeFileSync(store.pathOf("headless"), new Entry(MESSAGE).line() + "\n");
eq("a file without a header is not a session", store.list("/p").map((s) => s.id).sort().join(","), "s1,s2");
rmSync(dir, { recursive: true, force: true });
done();
