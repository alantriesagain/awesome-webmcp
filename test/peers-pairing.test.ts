// Pairing: the proof under the code, a join that holds (both sides end with each other's token),
// a wrong code, an expired one, a spent offer, and the request and answer round-tripping as JSON.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JoinAnswer, JoinRequest, PAIR_CODE_LIFE_MS, PairOffer, Registry, acceptJoin, newIdentity, newPairCode, newToken, proofHolds, proofOf, recordHost } from "../src/peers/index.ts";
import { done, eq, eqn, ok } from "@lightstart/test/assert.ts";

const root = mkdtempSync(join(tmpdir(), "widecode-peers-pair-"));
const host = newIdentity("desk");
const joiner = newIdentity("mac");
const hostRegistry = new Registry(join(root, "host.json"));
const joinerRegistry = new Registry(join(root, "joiner.json"));

{
  const code = newPairCode();
  eqn("six digits", code.length, 6);
  ok("digits only", /^[0-9]{6}$/.test(code));
  const proof = proofOf(code, joiner.publicKey);
  ok("the proof holds under the code", proofHolds(code, joiner.publicKey, proof));
  ok("and not under another", !proofHolds("000000", joiner.publicKey, proof) || code === "000000");
  ok("and not for another key", !proofHolds(code, host.publicKey, proof));
}

{
  const now = 1000000;
  const offer = new PairOffer("123456", now);
  ok("live for two minutes", offer.live(now + PAIR_CODE_LIFE_MS - 1) && !offer.live(now + PAIR_CODE_LIFE_MS));
  const theirToken = newToken();
  const req = new JoinRequest(joiner.publicKey, "mac", 7338, theirToken, proofOf("123456", joiner.publicKey));
  const parsed = JoinRequest.parse(JSON.stringify(req.toJson()));
  ok("the request round-trips", parsed !== null && parsed.publicKey === joiner.publicKey && parsed.port === 7338 && parsed.tokenForYou === theirToken);
  ok("a wrong code is refused", acceptJoin(hostRegistry, host, 7337, offer, now, new JoinRequest(joiner.publicKey, "mac", 7338, theirToken, proofOf("654321", joiner.publicKey)), "10.0.0.2") === null);
  ok("an expired offer is refused", acceptJoin(hostRegistry, host, 7337, offer, now + PAIR_CODE_LIFE_MS, req, "10.0.0.2") === null);
  ok("no offer is refused", acceptJoin(hostRegistry, host, 7337, null, now, req, "10.0.0.2") === null);
  eqn("nothing recorded so far", hostRegistry.peers.length, 0);
  const answer = acceptJoin(hostRegistry, host, 7337, offer, now + 10, req, "10.0.0.2");
  ok("a join that holds answers", answer !== null);
  if (answer === null) throw new Error("no answer");
  eq("with the host's id", answer.id, host.id);
  eqn("the host's port", answer.port, 7337);
  const onHost = hostRegistry.peerById(joiner.id);
  ok("the host recorded the joiner", onHost !== null && onHost.name === "mac" && onHost.address === "10.0.0.2" && onHost.port === 7338);
  eq("the host presents the joiner's token", onHost!.tokenWePresent, theirToken);
  eq("and expects the one it made", onHost!.tokenTheyPresent, answer.tokenForYou);
  const back = JoinAnswer.parse(JSON.stringify(answer.toJson()));
  ok("the answer round-trips", back !== null && back.tokenForYou === answer.tokenForYou && back.publicKey === host.publicKey);
  const onJoiner = recordHost(joinerRegistry, back!, theirToken, "10.0.0.1", now + 20);
  eq("the joiner recorded the host", onJoiner.id, host.id);
  eq("the tokens cross: what the joiner presents is what the host expects", onJoiner.tokenWePresent, onHost!.tokenTheyPresent);
  eq("and what the host presents is what the joiner expects", onHost!.tokenWePresent, onJoiner.tokenTheyPresent);
  ok("each side finds the other by its token", hostRegistry.peerByToken(onJoiner.tokenWePresent) === onHost && joinerRegistry.peerByToken(onHost!.tokenWePresent) === onJoiner);
  const reloaded = new Registry(hostRegistry.file);
  reloaded.load();
  eqn("the host saved", reloaded.peers.length, 1);
}

rmSync(root, { recursive: true, force: true });
done();
