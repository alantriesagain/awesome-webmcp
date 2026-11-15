// The daemon as a process would see it: one per store (a second start is refused while the first
// lives), the state file a client reads, the control API behind its token, pairing between two
// daemons over the loopback, and the stop that removes the file.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { SpawnOptions, spawnCapped } from "@light/lib/process.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, DaemonOptions, processAlive, readDaemonState, startDaemon } from "../src/peers/index.ts";
import { done, eq, eqn, ok } from "@light/test/assert.ts";

const root = mkdtempSync(join(tmpdir(), "widecode-peers-daemon-"));

const main = async (): Promise<void> => {
  ok("this process is alive", processAlive(process.pid));
  ok("a pid nobody has is not", !processAlive(2147483000));
  const line = DaemonClient.launchLine("/opt/widecode", ["--port", "0"]);
  ok("the launch line detaches with setsid where there is one", line.includes("setsid -f '/opt/widecode' '--peers-daemon' '--port' '0' </dev/null >/dev/null 2>&1"));
  ok("and with a subshell elsewhere", line.includes("else ('/opt/widecode' '--peers-daemon' '--port' '0' </dev/null >/dev/null 2>&1 &)"));

  const storeA = join(root, "a");
  const storeB = join(root, "b");
  mkdirSync(storeA);
  mkdirSync(storeB);
  const o = new DaemonOptions();
  o.port = 0;
  o.bind = "127.0.0.1";
  o.discovery = false;
  o.syncMs = 0;
  o.name = "desk";
  const a = await startDaemon(storeA, o);
  ok("the first daemon starts", typeof a !== "string");
  if (typeof a === "string") throw new Error(a);
  const state = readDaemonState(a.paths);
  ok("the state file names this process and the ports", state !== null && state.pid === process.pid && state.port === a.port && state.localPort === a.localPort && state.token === a.localToken);
  const second = await startDaemon(storeA, o);
  ok("a second start over the same store is refused while this one owns the file", typeof second === "string" || second === a);
  ok("the identity took the name", a.identity.name === "desk");

  const client = new DaemonClient(storeA);
  ok("a client finds it", await client.probe());
  const st = await client.request("GET", "/api/state", null);
  ok("and reads its state", st.ok && st.text.includes('"name":"desk"') && st.text.includes('"peers":[]'));
  const bad = await fetch("http://127.0.0.1:" + String(a.localPort) + "/api/state", { headers: { authorization: "Bearer nope" } });
  eqn("the control API wants its token", bad.status, 401);

  const ob = new DaemonOptions();
  ob.port = 0;
  ob.bind = "127.0.0.1";
  ob.discovery = false;
  ob.syncMs = 0;
  ob.name = "mac";
  const b = await startDaemon(storeB, ob);
  ok("a second machine's daemon starts over its own store", typeof b !== "string");
  if (typeof b === "string") throw new Error(b);

  const started = await client.request("POST", "/api/pair/start", null);
  ok("a code is shown", started.ok && started.text.includes('"code":"'));
  const code = started.text.slice(started.text.indexOf('"code":"') + 8, started.text.indexOf('"code":"') + 14);
  eqn("six digits", code.length, 6);
  const wrong = await b.pairJoin("127.0.0.1", a.port, code === "000000" ? "000001" : "000000", Date.now());
  ok("a wrong code is refused with a reason", typeof wrong === "string" && wrong.includes("refused the code"));
  const joined = await b.pairJoin("127.0.0.1", a.port, code, Date.now());
  ok("the right code pairs", typeof joined !== "string");
  if (typeof joined === "string") throw new Error(joined);
  eq("b knows a by name", joined.name, "desk");
  eqn("and by port", joined.port, a.port);
  const onA = a.registry.peerById(b.identity.id);
  ok("a knows b", onA !== null && onA.name === "mac" && onA.port === b.port);
  const again = await b.pairJoin("127.0.0.1", a.port, code, Date.now());
  ok("a spent code is refused", typeof again === "string");
  const after = await client.request("GET", "/api/state", null);
  ok("the state lists the peer without its tokens", after.ok && after.text.includes('"name":"mac"') && !after.text.includes(onA!.tokenTheyPresent) && !after.text.includes(onA!.tokenWePresent));

  const refreshed = await client.request("POST", "/api/peers/refresh", null);
  ok("refresh pings the peers and names those online", refreshed.ok && refreshed.text.includes(b.identity.id));
  const noOffer = await client.request("POST", "/api/peer/repos", { peerId: b.identity.id });
  ok("a peer's offers come through the daemon", noOffer.ok && noOffer.text.includes('"repos":[]'));
  const unknownPeer = await client.request("POST", "/api/peer/repos", { peerId: "nobody" });
  eqn("an unknown peer is 404", unknownPeer.status, 404);
  // Hosting: a bare repository made by name under the store, empty until the first push, which gives it its id.
  const hosted = await client.request("POST", "/api/host", { name: "mirror", path: "" });
  ok("a hosted repository is made by name", hosted.ok && hosted.text.includes('"key":"h/mirror"'));
  ok("as a bare repository under the store", existsSync(join(a.paths.hosted, "mirror.git", "HEAD")));
  ok("with no id yet", a.registry.repoByKey("h/mirror") !== null && a.registry.repoByKey("h/mirror")!.repoId === "");
  ok("a bad name is refused", (await client.request("POST", "/api/host", { name: "bad name", path: "" })).status === 400);
  const src = join(root, "src");
  mkdirSync(src);
  spawnSync("sh", ["-c", "git init -q -b main '" + src + "' && echo x > '" + src + "/a.txt' && git -C '" + src + "' add . && git -C '" + src + "' -c user.email=t@t -c user.name=t commit -qm first"], { encoding: "utf8" });
  const bToken = b.registry.peerById(a.identity.id)!.tokenWePresent;
  const po = new SpawnOptions();
  po.timeoutMs = 30000;
  const pushed = await spawnCapped("env", ["GIT_TERMINAL_PROMPT=0", "git", "-C", src, "-c", "credential.helper=", "-c", "http.extraHeader=Authorization: Bearer " + bToken, "push", "-q", "http://127.0.0.1:" + String(a.port) + "/h/mirror", "main"], po);
  eq("the other machine pushes into it", pushed.err, "");
  const stateAfter = await client.request("GET", "/api/state", null);
  ok("after the push the hosted repository has its id", stateAfter.ok && a.registry.repoByKey("h/mirror")!.repoId.length === 40);
  // Sync: b shares src live; a shares a clone of it; a's sync of b fetches b's copy into that clone
  // (a remote named after b, the token in its config) and counts the current branch against b's.
  const sharedSrc = await b.share(src, "", "live", null, null);
  ok("b shares src", typeof sharedSrc !== "string");
  const srcA = join(root, "src-a");
  spawnSync("git", ["clone", "-q", src, srcA], { encoding: "utf8" });
  const sharedA = await a.share(srcA, "", "live", null, null);
  ok("a shares its clone of it", typeof sharedA !== "string");
  const level = await client.request("POST", "/api/peer/sync", { peerId: b.identity.id });
  ok("a sync answers with the peer's repositories", level.ok && level.text.includes('"local":"' + srcA + '"'));
  ok("level: nothing to fetch, nothing ahead", level.text.includes('"ahead":0') && level.text.includes('"behind":0') && level.text.includes('"branch":"main"') && level.text.includes('"remote":"mac"'));
  eq("the remote named after the peer points at its copy", spawnSync("git", ["-C", srcA, "remote", "get-url", "mac"], { encoding: "utf8" }).stdout.trim(), "http://127.0.0.1:" + String(b.port) + "/" + (typeof sharedSrc === "string" ? "" : sharedSrc.key));
  spawnSync("sh", ["-c", "echo y > '" + src + "/b.txt' && git -C '" + src + "' add . && git -C '" + src + "' -c user.email=t@t -c user.name=t commit -qm 'second, on b'"], { encoding: "utf8" });
  const behind = await client.request("POST", "/api/peer/sync", { peerId: b.identity.id });
  ok("after a commit on b's side the sync counts it", behind.ok && behind.text.includes('"behind":1') && behind.text.includes('"subject":"second, on b"'));
  eq("the working tree of a's clone is untouched", spawnSync("git", ["-C", srcA, "status", "--short"], { encoding: "utf8" }).stdout.trim() + spawnSync("git", ["-C", srcA, "log", "-1", "--format=%s"], { encoding: "utf8" }).stdout.trim(), "first");
  ok("the state carries the sync", (await client.request("GET", "/api/state", null)).text.includes('"syncs":[{"peerId":"' + b.identity.id + '"'));
  // A hosted mirror b offers beside its live copy of src is listed as a push target, not compared.
  const hostedOnB = await b.host("src-mirror", "");
  ok("b hosts a mirror", typeof hostedOnB !== "string");
  const aToken = a.registry.peerById(b.identity.id)!.tokenWePresent;
  const mirrored = await spawnCapped("env", ["GIT_TERMINAL_PROMPT=0", "git", "-C", src, "-c", "credential.helper=", "-c", "http.extraHeader=Authorization: Bearer " + aToken, "push", "-q", "http://127.0.0.1:" + String(b.port) + "/h/src-mirror", "main"], po);
  eq("src is pushed into it", mirrored.err, "");
  const withMirror = await client.request("POST", "/api/peer/sync", { peerId: b.identity.id });
  ok("the mirror is listed beside the live copy, hosted, with no local path", withMirror.ok && withMirror.text.includes('"key":"h/src-mirror"') && withMirror.text.includes('"name":"src-mirror","repoId":"' + a.registry.repoByPath(srcA)!.repoId + '","mode":"hosted","local":""'));
  ok("while the live copy is the one compared", withMirror.text.includes('"local":"' + srcA + '"') && withMirror.text.includes('"behind":1'));
  // A repository b has and a lacks is listed as such, and /api/clone brings it here, shared live.
  const other = join(root, "other");
  mkdirSync(other);
  spawnSync("sh", ["-c", "git init -q -b main '" + other + "' && echo z > '" + other + "/c.txt' && git -C '" + other + "' add . && git -C '" + other + "' -c user.email=t@t -c user.name=t commit -qm other"], { encoding: "utf8" });
  const sharedOther = await b.share(other, "", "live", null, null);
  const notHere = await client.request("POST", "/api/peer/sync", { peerId: b.identity.id, key: typeof sharedOther === "string" ? "" : sharedOther.key });
  ok("a repository this machine lacks has no local path", notHere.ok && notHere.text.includes('"name":"other"') && notHere.text.includes('"local":""'));
  ok("a sync limited to one key keeps the others' last state", notHere.text.includes('"name":"src"') && notHere.text.includes('"behind":1'));
  const cloned = await client.request("POST", "/api/clone", { peerId: b.identity.id, key: typeof sharedOther === "string" ? "" : sharedOther.key, path: join(root, "other-a") });
  ok("clone answers with the share", cloned.ok && cloned.text.includes('"path":"' + join(root, "other-a") + '"'));
  ok("the clone is here, shared live, its origin named after the peer", existsSync(join(root, "other-a", "c.txt")) && a.registry.repoByPath(join(root, "other-a")) !== null && spawnSync("git", ["-C", join(root, "other-a"), "remote"], { encoding: "utf8" }).stdout.trim() === "mac");
  ok("and the sync now sees it here, level", (await client.request("POST", "/api/peer/sync", { peerId: b.identity.id })).text.includes('"local":"' + join(root, "other-a") + '"'));
  eqn("cloning onto a folder with files is 400", (await client.request("POST", "/api/clone", { peerId: b.identity.id, key: typeof sharedOther === "string" ? "" : sharedOther.key, path: srcA })).status, 400);
  const shareNothing = await client.request("POST", "/api/share", { path: join(root, "nowhere") });
  eqn("sharing a missing folder is 400", shareNothing.status, 400);
  const forgot = await client.request("POST", "/api/forget", { peerId: b.identity.id });
  ok("forget answers", forgot.ok && forgot.text.includes("true"));
  ok("and the peer is gone", a.registry.peerById(b.identity.id) === null);

  const stop = await client.request("POST", "/api/stop", null);
  ok("stop answers", stop.ok);
  await new Promise((resolve) => setTimeout(resolve, 200));
  ok("the state file is gone", !existsSync(a.paths.state));
  ok("the client no longer finds it", !(await client.probe()));
  b.stop();
  ok("b's file is gone too", !existsSync(b.paths.state));
  rmSync(root, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
