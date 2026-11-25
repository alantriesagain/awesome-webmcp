// The git server end to end over the loopback: a repository with two branches and a tag is shared,
// a paired peer clones it with its token (and cannot without), ls-remote sees the tag, protocol v2
// works, a fetch forced through the chunked gzip path works, a branch filter hides the other
// branch, an allow list that leaves the peer out answers 404, a hosted bare repository takes a
// push while the live one refuses it, and /repos lists what the peer may fetch with the tips.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, DaemonOptions, DaemonPaths, Peer, Registry, isPrivateAddress, newIdentity, newToken, pktLine, plainAddress, urlHost } from "../src/peers/index.ts";
import { SpawnOptions, spawnCapped } from "@lightstart/lib/process.ts";
import { done, eq, eqn, ok } from "@lightstart/test/assert.ts";

const root = mkdtempSync(join(tmpdir(), "lightcode-peers-git-"));
const store = join(root, "store");
mkdirSync(store);

class GitRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;

  constructor(code: number, out: string, err: string) {
    this.code = code;
    this.out = out;
    this.err = err;
  }
}

// git runs asynchronously, since the server it talks to lives in this process; it never prompts
// for credentials (a 401 is an exit, not a question) and ignores the user's credential helpers.
const git = async (...args: string[]): Promise<GitRun> => {
  const o = new SpawnOptions();
  o.timeoutMs = 60000;
  const r = await spawnCapped("env", ["GIT_TERMINAL_PROMPT=0", "git", "-c", "credential.helper=", ...args], o);
  return new GitRun(r.code, r.text, r.err);
};
const commit = async (repo: string, file: string, text: string, message: string): Promise<void> => {
  writeFileSync(join(repo, file), text);
  await git("-C", repo, "add", ".");
  await git("-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message);
};

{
  eq("a pkt-line carries its length", pktLine("# service=git-upload-pack\n"), "001e# service=git-upload-pack\n");
  ok("loopback is private", isPrivateAddress("127.0.0.1") && isPrivateAddress("::1") && isPrivateAddress("::ffff:127.0.0.1"));
  ok("the private ranges", isPrivateAddress("10.1.2.3") && isPrivateAddress("192.168.15.51") && isPrivateAddress("172.16.0.9") && isPrivateAddress("172.31.255.1") && isPrivateAddress("fe80::1") && isPrivateAddress("fd12::1"));
  ok("public addresses are not", !isPrivateAddress("8.8.8.8") && !isPrivateAddress("172.32.0.1") && !isPrivateAddress("2a00::1") && !isPrivateAddress("nonsense"));
  eq("a mapped IPv4 is recorded as IPv4", plainAddress("::ffff:192.168.1.5"), "192.168.1.5");
  eq("an IPv6 host is bracketed in a URL", urlHost("fe80::1") + " " + urlHost("10.0.0.2"), "[fe80::1] 10.0.0.2");
}

const main = async (): Promise<void> => {
  const repo = join(root, "live");
  mkdirSync(repo);
  await git("init", "-q", "-b", "main", repo);
  await commit(repo, "a.txt", "one\n", "first");
  await commit(repo, "a.txt", "two\n", "second");
  await git("-C", repo, "tag", "v1");
  await git("-C", repo, "checkout", "-qb", "topic");
  await commit(repo, "b.txt", "topic\n", "on topic");
  await git("-C", repo, "checkout", "-q", "main");
  await git("-C", repo, "stash", "list");

  const paths = new DaemonPaths(store);
  const registry = new Registry(paths.registry);
  const daemon = new Daemon(paths, newIdentity("desk"), registry);
  const logLines: string[] = [];
  daemon.onLog = (line: string) => {
    logLines.push(line);
  };
  const o = new DaemonOptions();
  o.port = 0;
  o.bind = "127.0.0.1";
  o.discovery = false;
  eq("the daemon starts", await daemon.start(o), "");
  ok("on a port", daemon.port > 0 && daemon.localPort > 0);

  const shared = await daemon.share(repo, "", "live", null, null);
  ok("the live repository is shared", typeof shared !== "string");
  if (typeof shared === "string") throw new Error(shared);
  eq("named after its folder", shared.name, "live");
  eq("identified by its root commit", shared.repoId, (await git("-C", repo, "rev-list", "--max-parents=0", "HEAD")).out.trim());
  eq("a folder that is no repository is refused", typeof (await daemon.share(root, "", "live", null, null)), "string");

  const token = newToken();
  const peer = new Peer("c".repeat(64), "mac", "pk", token, "other", "127.0.0.1", 0, 0);
  registry.upsertPeer(peer);
  const base = "http://127.0.0.1:" + String(daemon.port);
  const url = base + "/" + shared.key;
  eq("a live share is fetched at r/<root commit>", shared.key, "r/" + shared.repoId);
  const auth = "http.extraHeader=Authorization: Bearer " + token;

  const noToken = await git("clone", "-q", url, join(root, "clone-no-token"));
  ok("a clone without the token fails", noToken.code !== 0);
  ok("as an authentication failure", noToken.err.includes("401") || noToken.err.includes("Authentication failed") || noToken.err.includes("prompts disabled"));

  const clone = join(root, "clone");
  const cloned = await git("-c", auth, "clone", "-q", url, clone);
  eq("a clone with the token succeeds", cloned.err.trim(), "");
  eqn("exit 0", cloned.code, 0);
  eqn("both commits of main came", Number((await git("-C", clone, "rev-list", "--count", "HEAD")).out.trim()), 2);
  ok("the topic branch is a remote-tracking ref", (await git("-C", clone, "branch", "-r")).out.includes("origin/topic"));
  ok("the tag came along", (await git("-C", clone, "tag")).out.includes("v1"));
  const remote = (await git("-c", auth, "ls-remote", url)).out;
  ok("ls-remote hides remote-tracking refs and stashes", !remote.includes("refs/remotes/") && !remote.includes("refs/stash"));
  ok("protocol v2 works", (await git("-c", auth, "-c", "protocol.version=2", "ls-remote", url)).out.includes("refs/heads/main"));
  ok("protocol v0 works", (await git("-c", auth, "-c", "protocol.version=0", "ls-remote", url)).out.includes("refs/heads/main"));
  ok("the server saw a v2 advertisement", logLines.some((l: string) => l.includes("version=2")));

  await commit(repo, "a.txt", "three\n", "third");
  const fetched = await git("-C", clone, "-c", auth, "fetch", "-q", "origin");
  eq("a fetch after a new commit works", fetched.err, "");
  eq("and brought it", (await git("-C", clone, "log", "-1", "--format=%s", "origin/main")).out.trim(), "third");
  // git gzips a request body it finds large; the inflating path is driven directly: a protocol v2
  // ls-refs request, gzipped, must answer the branches.
  const lsRefs = "0014command=ls-refs\n00010000";
  const zipped = await fetch(url + "/git-upload-pack", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/x-git-upload-pack-request", "content-encoding": "gzip", "git-protocol": "version=2" },
    body: new Uint8Array(gzipSync(Buffer.from(lsRefs, "utf8"))),
  });
  eqn("a gzipped request is answered", zipped.status, 200);
  const refs = await zipped.text();
  ok("with the refs", refs.includes("refs/heads/main") && refs.includes("refs/heads/topic"));
  ok("the server logged the inflated body", logLines.some((l: string) => l.includes(" gzip in ")));

  const filtered = await daemon.share(repo, "live", "live", ["main"], null);
  ok("shared again with a filter", typeof filtered !== "string");
  const onlyMain = (await git("-c", auth, "ls-remote", url)).out;
  ok("the filter keeps main", onlyMain.includes("refs/heads/main"));
  ok("and hides topic", !onlyMain.includes("refs/heads/topic"));
  ok("tags stay", onlyMain.includes("refs/tags/v1"));

  const walled = await daemon.share(repo, "live", "live", null, ["d".repeat(64)]);
  ok("shared with an allow list", typeof walled !== "string");
  const refused = await git("-c", auth, "ls-remote", url);
  ok("a peer outside the allow list gets 404", refused.code !== 0 && (refused.err.includes("404") || refused.err.includes("not found")));
  await daemon.share(repo, "live", "live", null, null);

  const twice = await daemon.share(clone, "", "live", null, null);
  ok("a second checkout of the same repository is refused, not swapped in", typeof twice === "string" && twice.includes("already shared from " + repo));
  const pushLive = await git("-C", clone, "-c", auth, "push", "-q", url, "HEAD:refs/heads/from-mac");
  ok("a push to a live repository is refused", pushLive.code !== 0 && pushLive.err.includes("403"));

  const hosted = join(root, "hosted.git");
  eqn("a bare clone to host", (await git("clone", "-q", "--bare", repo, hosted)).code, 0);
  ok("a checkout cannot be hosted", typeof (await daemon.share(repo, "x", "hosted", null, null)) === "string");
  ok("a bare repository cannot be served live", typeof (await daemon.share(hosted, "x", "live", null, null)) === "string");
  const host = await daemon.share(hosted, "", "hosted", null, null);
  ok("the bare repository is hosted", typeof host !== "string");
  if (typeof host === "string") throw new Error(host);
  eq("named without .git", host.name, "hosted");
  eq("and fetched at h/<name>", host.key, "h/hosted");
  eq("the same root commit as the live checkout, both served", host.repoId, shared.repoId);
  eqn("two shares", registry.repos.length, 2);
  ok("a hosted name must be URL-safe", typeof (await daemon.share(hosted, "bad name", "hosted", null, null)) === "string");
  const hostedUrl = base + "/" + host.key;
  const push = await git("-C", clone, "-c", auth, "push", "-q", hostedUrl, "HEAD:refs/heads/from-mac");
  eq("a push to the hosted repository succeeds", push.err.trim(), "");
  eqn("exit 0", push.code, 0);
  ok("and the branch is there", (await git("-C", hosted, "branch")).out.includes("from-mac"));

  const list = await fetch(base + "/repos", { headers: { authorization: "Bearer " + token } });
  eqn("/repos answers", list.status, 200);
  const text = await list.text();
  ok("with both repositories", text.includes('"name":"live"') && text.includes('"name":"hosted"'));
  ok("each with its key", text.includes('"key":"r/' + shared.repoId + '"') && text.includes('"key":"h/hosted"'));
  ok("and their tips", text.includes('"name":"main","sha":"'));
  const ping = await fetch(base + "/ping");
  eqn("/ping needs no token", ping.status, 200);
  const nothing = await fetch(base + "/repos");
  eqn("/repos does", nothing.status, 401);
  const unknown = await fetch(base + "/r/" + "0".repeat(40) + "/info/refs?service=git-upload-pack", { headers: { authorization: "Bearer " + token } });
  eqn("an unknown repository is 404", unknown.status, 404);
  const dumb = await fetch(url + "/info/refs", { headers: { authorization: "Bearer " + token } });
  eqn("the dumb protocol is not served", dumb.status, 403);
  ok("the server logged who fetched", logLines.some((l: string) => l.startsWith("upload-pack mac live")));
  eq("the peer's address was recorded, plain", registry.peerById(peer.id)!.address, "127.0.0.1");

  daemon.stop();
  rmSync(root, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
