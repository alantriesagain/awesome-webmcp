// ffi: @lightstart/plugins/native/ffi.json
// The file shown, kept with the session: a session keeps the work tree's file in the code column
// in its record; resuming it later opens that file again, and a file gone since leaves the column
// as it is. A new session (no id yet) keeps nothing. The agent a session belongs to is kept in its
// record, and resuming the session chooses that agent.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/conversation/agent.ts";
import { SessionMeta } from "../src/conversation/session-store.ts";
import { Store } from "../src/services/store.ts";
import type { Widecode } from "../src/compose.ts";
import { done, eq } from "@lightstart/test/assert.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";

class OtherAgent extends Agent {
  override id(): string {
    return "other";
  }

  override name(): string {
    return "Other";
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-reopen-"));
  const home = mkdtempSync(join(tmpdir(), "widecode-home-"));
  for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(folder, f), f + "\n");
  const store = new Store(home);
  const w = await openWidecode({
    folder,
    load: true,
    before: async (w: Widecode) => {
      await w.host.useStore(store);
    },
  });
  const c = w.host.conversation;
  const records = w.host.session.records;
  if (records === null) throw new Error("no records");
  const kept = (id: string): string => {
    const meta = records.session(id, folder);
    return meta !== null ? meta.file : "(no record)";
  };

  await w.code.load("a.txt");
  eq("a new session keeps nothing", kept("s1"), "(no record)");
  c.resume("s1", "");
  await wait(50);
  eq("resumed, a session without a file keeps the one shown", kept("s1"), "a.txt");
  await w.code.load("b.txt");
  eq("and then each file shown", kept("s1"), "b.txt");

  c.reset();
  await w.code.load("c.txt");
  eq("a new session again: s1 keeps its own", kept("s1"), "b.txt");
  c.resume("s1", "");
  await wait(100);
  eq("resuming s1 opens its file", w.host.roles.code.path(), "b.txt");

  c.resume("s2", "");
  await wait(50);
  eq("s2 keeps the file shown when it was resumed", kept("s2"), "b.txt");
  const meta = records.sessionOrNew("s2", folder);
  meta.file = "gone.txt";
  records.saveSession(meta);
  c.reset();
  await w.code.load("a.txt");
  c.resume("s2", "");
  await wait(100);
  eq("a file gone since: the column stays, and keeps it for the session", w.host.roles.code.path() + " " + kept("s2"), "a.txt a.txt");

  w.host.session.addAgent("test", new OtherAgent());
  const theirs = new SessionMeta();
  theirs.id = "s9";
  theirs.folder = folder;
  theirs.title = "theirs";
  theirs.agent = "other";
  records.saveSession(theirs);
  const ghosts = new SessionMeta();
  ghosts.id = "s10";
  ghosts.folder = folder;
  ghosts.agent = "ghost";
  records.saveSession(ghosts);
  const blank = new SessionMeta();
  blank.id = "s11";
  blank.folder = folder;
  records.saveSession(blank);
  await records.settled();
  eq("resuming a session of another agent chooses that agent, with the record's title", w.host.session.resumeSession("s9", "") + "|" + w.host.conversation.agent.id() + " " + w.host.conversation.title, "|other theirs");
  eq("a record naming no agent keeps the one chosen", w.host.session.resumeSession("s11", "") + "|" + w.host.conversation.agent.id(), "|other");
  const why = w.host.session.resumeSession("s10", "");
  eq("a record naming an agent nothing brings says so, and resumes nothing", (why.length > 0 ? "why" : "") + " " + w.host.conversation.sessionId, "why s11");
  w.host.conversation.setModel("m1");
  await records.settled();
  const stamped = records.session("s11", folder);
  eq("a model change stamps the record with the agent it ran on", stamped !== null ? stamped.agent + " " + stamped.model : "(no record)", "other m1");

  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
