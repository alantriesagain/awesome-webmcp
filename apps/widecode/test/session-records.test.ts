// The folder's session records over the sessions model: a record saved lands in the folder's
// .widecode/sessions.jsonl and comes back from fresh records of the same folder; one an earlier
// widecode kept as sessions/<id>.json is imported when the folder opens; an unknown id has no
// record; records of another folder stay apart; the limits are the store's.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hook } from "@light/lib/hook.ts";
import { done, eq, ok } from "@light/test/assert.ts";
import { SessionRecords } from "../src/services/sessions.ts";
import { Store } from "../src/services/store.ts";

const home = mkdtempSync(join(tmpdir(), "widecode-records-home-"));
const project = mkdtempSync(join(tmpdir(), "widecode-records-"));
const other = mkdtempSync(join(tmpdir(), "widecode-records-other-"));
mkdirSync(join(project, ".widecode", "sessions"), { recursive: true });
writeFileSync(join(project, ".widecode", "sessions", "old-1.json"), JSON.stringify({ id: "old-1", folder: project, title: "From before", titleBy: "claude", costUsd: 0.25 }));
const store = new Store(home);
const changed = new Hook();
let fired = 0;
changed.add("test", () => {
  fired++;
});
const records = new SessionRecords(store, changed);
await records.open(project);
ok("an earlier record file is imported when the folder opens", (() => {
  const m = records.session("old-1", project);
  return m !== null && m.title === "From before" && m.titleBy === "claude" && m.costUsd === 0.25;
})());
ok("and the file stays", existsSync(join(project, ".widecode", "sessions", "old-1.json")));
ok("an unknown session has no record", records.session("nope", project) === null);
const m = records.sessionOrNew("s-1", project);
m.title = "Fix the parser";
m.titleBy = "user";
m.costUsd = 0.5;
records.saveSession(m);
ok("a record saved is the folder's at once", records.session("s-1", project) === m);
await records.settled();
ok("and lands in the folder's sessions.jsonl", readFileSync(join(project, ".widecode", "sessions.jsonl"), "utf8").includes("Fix the parser"));
m.contextWindow = 1000000;
m.baseCommit = "abc123";
records.saveSession(m);
await records.settled();
await records.close();
const again = new SessionRecords(store, new Hook());
await again.open(project);
const back = again.session("s-1", project);
eq("a record round trip from fresh records", back !== null ? String(back.folder === project) + "|" + back.title + "|" + back.titleBy + "|" + String(back.costUsd) + "|" + String(back.contextWindow) + "|" + back.baseCommit : "none", "true|Fix the parser|user|0.5|1000000|abc123");
eq("the records newest first, the imported one among them", again.all().map((r) => r.id).join(","), "s-1,old-1");
ok("the hook fired as rows landed", fired > 0);
await again.open(other);
ok("another folder's records are its own", again.session("s-1", other) === null && again.all().length === 0);
eq("the limits are the store's", String(again.limits().fiveHour.usedPercent), "-1");
await again.close();
rmSync(home, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });
rmSync(other, { recursive: true, force: true });
done();
