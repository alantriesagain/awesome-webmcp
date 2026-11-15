// The identity: made once, its id the public key's SHA-256, kept in a file the user alone reads.
// The registry: peers found by their token in constant time, repositories shared and unshared,
// allow lists, and a round trip through its file.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Identity, Peer, Registry, SharedRepo, loadOrCreateIdentity, newIdentity, newToken, peerIdOf, sameSecret } from "../src/peers/index.ts";
import { done, eq, eqn, ok } from "@lightstart/test/assert.ts";

const root = mkdtempSync(join(tmpdir(), "widecode-peers-id-"));

{
  const me = newIdentity("laptop");
  eqn("the id is a sha256 in hex", me.id.length, 64);
  ok("hex digits", /^[0-9a-f]+$/.test(me.id));
  eq("the id follows the public key", peerIdOf(me.publicKey), me.id);
  ok("a PEM public key", me.publicKey.startsWith("-----BEGIN PUBLIC KEY-----"));
  ok("a PEM private key", me.privateKey.startsWith("-----BEGIN PRIVATE KEY-----"));
  ok("two identities differ", newIdentity("other").id !== me.id);
  const again = Identity.parse(JSON.stringify(me.toJson()));
  ok("parses back", again !== null && again.id === me.id && again.name === "laptop");
  eqn("a token is base64url of 32 bytes", newToken().length, 43);
  ok("tokens are random", newToken() !== newToken());
  ok("sameSecret holds for equal", sameSecret("abc", "abc"));
  ok("and fails for different lengths", !sameSecret("abc", "abcd"));
  ok("and for empty", !sameSecret("", ""));
}

{
  const file = join(root, "identity.json");
  const first = loadOrCreateIdentity(file, "desk");
  const second = loadOrCreateIdentity(file, "ignored");
  eq("the file keeps the identity", second.id, first.id);
  eq("and its name", second.name, "desk");
  eqn("readable by the user alone", statSync(file).mode & 0o777, 0o600);
}

{
  const r = new Registry(join(root, "peers.json"));
  r.load();
  eqn("an absent file is empty", r.peers.length + r.repos.length, 0);
  const a = new Peer("a".repeat(64), "mac", "pk-a", "they-a", "we-a", "192.168.1.2", 7337, 1000);
  const b = new Peer("b".repeat(64), "desk", "pk-b", "they-b", "we-b", "", 0, 0);
  r.upsertPeer(a);
  r.upsertPeer(b);
  ok("found by token", r.peerByToken("they-b") === b);
  ok("a token nobody presents", r.peerByToken("they-c") === null);
  ok("an empty token", r.peerByToken("") === null);
  ok("found by name", r.peerNamed("mac") === a);
  ok("or by id", r.peerNamed("b".repeat(64)) === b);
  const live = new SharedRepo("1".repeat(40), "/tmp/x", "x", "live", null, null);
  const filtered = new SharedRepo("2".repeat(40), "/tmp/y", "y", "hosted", ["main"], [a.id]);
  r.share(live);
  r.share(filtered);
  ok("a live repo", !live.hosted);
  ok("a hosted repo", filtered.hosted);
  ok("no allow list allows everyone", r.allows(live, b));
  ok("an allow list names its peers", r.allows(filtered, a) && !r.allows(filtered, b));
  eqn("what b may see", r.reposFor(b).length, 1);
  r.save();
  eqn("the file is private", statSync(r.file).mode & 0o777, 0o600);
  const back = new Registry(r.file);
  back.load();
  eqn("peers round trip", back.peers.length, 2);
  eqn("repos round trip", back.repos.length, 2);
  eq("a live share is keyed by its root commit", live.key, "r/" + "1".repeat(40));
  eq("a hosted one by its name", filtered.key, "h/y");
  ok("repoById finds live shares only", back.repoById("1".repeat(40)) !== null && back.repoById("2".repeat(40)) === null);
  const y = back.repoByKey("h/y");
  ok("the filter and the allow list came back", y !== null && y.branches !== null && y.branches[0] === "main" && y.allow !== null && y.allow[0] === a.id);
  const upd = new Peer(a.id, "macbook", "pk-a", "they-a2", "we-a", "10.0.0.5", 7337, 2000);
  back.upsertPeer(upd);
  eqn("an upsert replaces", back.peers.length, 2);
  ok("with the new record", back.peerByToken("they-a2") === upd && back.peerByToken("they-a") === null);
  ok("unshare by key", back.unshare("r/" + "1".repeat(40)) && back.repoById("1".repeat(40)) === null);
  ok("unsharing twice is false", !back.unshare("r/" + "1".repeat(40)));
  ok("sharing the same path again replaces", (back.share(new SharedRepo("3".repeat(40), "/tmp/y", "y2", "live", null, null)), back.repos.length === 1 && back.repoByPath("/tmp/y") !== null));
  ok("remove a peer", back.removePeer(a.id) && back.peerById(a.id) === null && !back.removePeer(a.id));
  const pub = JSON.stringify(b.toPublicJson());
  ok("the public record carries no token", !pub.includes("they-b") && !pub.includes("we-b") && pub.includes("desk"));
}

rmSync(root, { recursive: true, force: true });
done();
