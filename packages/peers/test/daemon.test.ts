// The daemon as a process would see it: one per store (a second start is refused while the first
// lives), the state file a client reads, the control API behind its token, pairing between two
// daemons over the loopback, and the stop that removes the file.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, DaemonOptions, processAlive, readDaemonState, startDaemon } from "@widecode/peers";
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
