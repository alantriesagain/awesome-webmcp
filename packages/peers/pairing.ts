// Pairing two machines: the host shows a six-digit code that lives two minutes; the joiner posts its
// public key, its name, its port, a token for the host to present later, and a proof (an HMAC of its
// public key under the code); the host checks the proof in constant time and answers with its own
// key, name, port and a token for the joiner. Both record the other with the two tokens. A code is
// spent by the first join that holds.
import { createHmac, randomInt } from "node:crypto";
import { num, parseJson, recordOf, str } from "@light/lib/json.ts";
import { Identity, newToken, peerIdOf } from "./identity.ts";
import { urlHost } from "./git-http.ts";
import { Peer, Registry, sameSecret } from "./registry.ts";

export const PAIR_CODE_LIFE_MS = 120000;

export const newPairCode = (): string => String(randomInt(0, 1000000)).padStart(6, "0");

export const proofOf = (code: string, publicKey: string): string => createHmac("sha256", code).update(publicKey).digest("hex");

export const proofHolds = (code: string, publicKey: string, proof: string): boolean => sameSecret(proofOf(code, publicKey), proof);

/** A code the host is showing, until it is spent or expires. */
export class PairOffer {
  readonly code: string;
  readonly expiresMs: number;

  constructor(code: string, nowMs: number) {
    this.code = code;
    this.expiresMs = nowMs + PAIR_CODE_LIFE_MS;
  }

  live(nowMs: number): boolean {
    return nowMs < this.expiresMs;
  }

  toJson(): unknown {
    const v: unknown = { code: this.code, expiresMs: this.expiresMs };
    return v;
  }
}

/** What the joiner posts to `/pair`. */
export class JoinRequest {
  readonly publicKey: string;
  readonly name: string;
  readonly port: number;
  readonly tokenForYou: string;
  readonly proof: string;

  constructor(publicKey: string, name: string, port: number, tokenForYou: string, proof: string) {
    this.publicKey = publicKey;
    this.name = name;
    this.port = port;
    this.tokenForYou = tokenForYou;
    this.proof = proof;
  }

  toJson(): unknown {
    const v: unknown = { publicKey: this.publicKey, name: this.name, port: this.port, tokenForYou: this.tokenForYou, proof: this.proof };
    return v;
  }

  static parse(text: string): JoinRequest | null {
    const r = recordOf(parseJson(text));
    if (r === null) return null;
    const publicKey = str(r["publicKey"]);
    const tokenForYou = str(r["tokenForYou"]);
    const proof = str(r["proof"]);
    if (publicKey.length === 0 || tokenForYou.length === 0 || proof.length === 0) return null;
    return new JoinRequest(publicKey, str(r["name"]), num(r["port"], 0), tokenForYou, proof);
  }
}

/** What the host answers a join that held. */
export class JoinAnswer {
  readonly id: string;
  readonly publicKey: string;
  readonly name: string;
  readonly port: number;
  readonly tokenForYou: string;

  constructor(id: string, publicKey: string, name: string, port: number, tokenForYou: string) {
    this.id = id;
    this.publicKey = publicKey;
    this.name = name;
    this.port = port;
    this.tokenForYou = tokenForYou;
  }

  toJson(): unknown {
    const v: unknown = { id: this.id, publicKey: this.publicKey, name: this.name, port: this.port, tokenForYou: this.tokenForYou };
    return v;
  }

  static parse(text: string): JoinAnswer | null {
    const r = recordOf(parseJson(text));
    if (r === null) return null;
    const publicKey = str(r["publicKey"]);
    const tokenForYou = str(r["tokenForYou"]);
    if (publicKey.length === 0 || tokenForYou.length === 0) return null;
    return new JoinAnswer(str(r["id"]), publicKey, str(r["name"]), num(r["port"], 0), tokenForYou);
  }
}

/**
 * The host's side: `body` against `offer` at `nowMs`. A join that holds records the joiner in
 * `registry` (saved) and answers; null refuses (no offer, an expired one, a proof that does not hold).
 */
export const acceptJoin = (registry: Registry, identity: Identity, hostPort: number, offer: PairOffer | null, nowMs: number, body: JoinRequest, address: string): JoinAnswer | null => {
  if (offer === null || !offer.live(nowMs)) return null;
  if (!proofHolds(offer.code, body.publicKey, body.proof)) return null;
  const peer = new Peer(peerIdOf(body.publicKey), body.name, body.publicKey, newToken(), body.tokenForYou, address, body.port, nowMs);
  registry.upsertPeer(peer);
  registry.save();
  return new JoinAnswer(identity.id, identity.publicKey, identity.name, hostPort, peer.tokenTheyPresent);
};

/** The joiner's side, once the host answered: the host recorded in `registry` (saved) as a peer. */
export const recordHost = (registry: Registry, answer: JoinAnswer, tokenTheyPresent: string, address: string, nowMs: number): Peer => {
  const peer = new Peer(peerIdOf(answer.publicKey), answer.name, answer.publicKey, tokenTheyPresent, answer.tokenForYou, address, answer.port, nowMs);
  registry.upsertPeer(peer);
  registry.save();
  return peer;
};

/** The joiner's whole exchange with the host at `address:port` under `code`: the peer, or why not. */
export const joinPeer = async (registry: Registry, identity: Identity, myPort: number, address: string, port: number, code: string, nowMs: number): Promise<Peer | string> => {
  const tokenTheyPresent = newToken();
  const body = new JoinRequest(identity.publicKey, identity.name, myPort, tokenTheyPresent, proofOf(code, identity.publicKey));
  let status = 0;
  let text = "";
  try {
    const res = await fetch("http://" + urlHost(address) + ":" + String(port) + "/pair", { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(body.toJson()) });
    status = res.status;
    text = await res.text();
  } catch (err) {
    return "no answer from " + address + ":" + String(port) + (err instanceof Error ? " (" + err.message + ")" : "");
  }
  if (status !== 200) return address + ":" + String(port) + " refused the code" + (text.length > 0 ? ": " + text.trim() : "");
  const answer = JoinAnswer.parse(text);
  if (answer === null) return address + ":" + String(port) + " answered something else";
  return recordHost(registry, answer, tokenTheyPresent, address, nowMs);
};
