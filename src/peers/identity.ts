// A machine's identity on the bridge: an ed25519 keypair made once and kept in the store, the peer
// id (its public key's SHA-256) and the name it announces (the hostname until renamed). Tokens are
// 32 random bytes as base64url. Nothing is signed yet: the keypair is what a later version pins.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseJson, recordOf, str } from "@light/lib/json.ts";

/** `b` as base64url (no padding), without relying on the runtime naming the encoding. */
export const base64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const newToken = (): string => base64url(randomBytes(32));

/** The peer id of a public key: the SHA-256 of its base64 body, as hex. */
export const peerIdOf = (publicKeyPem: string): string => createHash("sha256").update(publicKeyPem.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "")).digest("hex");

/** A peer id as the views show it. */
export const shortId = (id: string): string => id.slice(0, 8);

export class Identity {
  readonly id: string;
  readonly publicKey: string;
  readonly privateKey: string;
  name: string;

  constructor(publicKey: string, privateKey: string, name: string) {
    this.id = peerIdOf(publicKey);
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.name = name;
  }

  toJson(): unknown {
    const v: unknown = { id: this.id, name: this.name, publicKey: this.publicKey, privateKey: this.privateKey };
    return v;
  }

  static parse(text: string): Identity | null {
    const r = recordOf(parseJson(text));
    if (r === null) return null;
    const publicKey = str(r["publicKey"]);
    const privateKey = str(r["privateKey"]);
    if (publicKey.length === 0 || privateKey.length === 0) return null;
    return new Identity(publicKey, privateKey, str(r["name"]));
  }
}

/** A fresh identity named `name`. */
export const newIdentity = (name: string): Identity => {
  const pair = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  return new Identity(pair.publicKey, pair.privateKey, name);
};

/** Write `identity` to `file`, readable by the user alone. */
export const saveIdentity = (file: string, identity: Identity): void => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(identity.toJson(), null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
};

/** The identity in `file`, made and written when there is none (or the file is unreadable). */
export const loadOrCreateIdentity = (file: string, defaultName: string): Identity => {
  if (existsSync(file)) {
    const kept = Identity.parse(readFileSync(file, "utf8"));
    if (kept !== null) {
      if (kept.name.length === 0) kept.name = defaultName;
      return kept;
    }
  }
  const made = newIdentity(defaultName);
  saveIdentity(file, made);
  return made;
};
