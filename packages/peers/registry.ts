// The registry a machine keeps for the bridge, in the store's peers.json: the peers it paired with
// (their key, the token they present to us and the one we present to them, where they were last
// seen) and the repositories it shares (by root commit, with the path, a mode, a branch filter and
// an allow list). Secrets live here and never in config.json.
import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { writeAtomic } from "@light/lib/fs.ts";
import { listOf, num, parseJson, recordOf, str, strs } from "@light/lib/json.ts";

/** Two secrets compared in constant time; different lengths are a mismatch. */
export const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

export class Peer {
  readonly id: string;
  name: string;
  readonly publicKey: string;
  /** The token this peer presents to us. */
  readonly tokenTheyPresent: string;
  /** The token we present to this peer. */
  readonly tokenWePresent: string;
  address: string;
  port: number;
  lastSeenMs: number;

  constructor(id: string, name: string, publicKey: string, tokenTheyPresent: string, tokenWePresent: string, address: string, port: number, lastSeenMs: number) {
    this.id = id;
    this.name = name;
    this.publicKey = publicKey;
    this.tokenTheyPresent = tokenTheyPresent;
    this.tokenWePresent = tokenWePresent;
    this.address = address;
    this.port = port;
    this.lastSeenMs = lastSeenMs;
  }

  toJson(): unknown {
    const v: unknown = {
      id: this.id,
      name: this.name,
      publicKey: this.publicKey,
      tokenTheyPresent: this.tokenTheyPresent,
      tokenWePresent: this.tokenWePresent,
      address: this.address,
      port: this.port,
      lastSeenMs: this.lastSeenMs,
    };
    return v;
  }

  /** What other machines and the views may see of this peer: no tokens. */
  toPublicJson(): unknown {
    const v: unknown = { id: this.id, name: this.name, address: this.address, port: this.port, lastSeenMs: this.lastSeenMs };
    return v;
  }

  static parse(v: unknown): Peer | null {
    const r = recordOf(v);
    if (r === null) return null;
    const id = str(r["id"]);
    if (id.length === 0) return null;
    return new Peer(id, str(r["name"]), str(r["publicKey"]), str(r["tokenTheyPresent"]), str(r["tokenWePresent"]), str(r["address"]), num(r["port"], 0), num(r["lastSeenMs"], 0));
  }
}

/** A repository this machine shares: "live" is a working checkout served read-only, "hosted" a bare repository that takes pushes. */
export class SharedRepo {
  /** The oldest root commit; "" for a hosted repository nobody pushed to yet. */
  repoId: string;
  readonly path: string;
  name: string;
  mode: string;
  /** The branches served, null for all of them. */
  branches: string[] | null;
  /** The peer ids allowed, null for every paired peer. */
  allow: string[] | null;

  constructor(repoId: string, path: string, name: string, mode: string, branches: string[] | null, allow: string[] | null) {
    this.repoId = repoId;
    this.path = path;
    this.name = name;
    this.mode = mode === "hosted" ? "hosted" : "live";
    this.branches = branches;
    this.allow = allow;
  }

  get hosted(): boolean {
    return this.mode === "hosted";
  }

  /** The path a peer fetches it at: a live checkout by its root commit (`r/<id>`), a hosted repository by its name (`h/<name>`), so a checkout and a hosted mirror of the same repository can both be served. */
  get key(): string {
    return this.hosted ? "h/" + this.name : "r/" + this.repoId;
  }

  toJson(): unknown {
    const v: unknown = { key: this.key, repoId: this.repoId, path: this.path, name: this.name, mode: this.mode, branches: this.branches, allow: this.allow };
    return v;
  }

  /** What a peer sees of it: the id, the name and the mode. */
  toPublicJson(): unknown {
    const v: unknown = { key: this.key, repoId: this.repoId, name: this.name, mode: this.mode };
    return v;
  }

  static parse(v: unknown): SharedRepo | null {
    const r = recordOf(v);
    if (r === null) return null;
    const repoId = str(r["repoId"]);
    const path = str(r["path"]);
    const mode = str(r["mode"]);
    if (path.length === 0 || (repoId.length === 0 && mode !== "hosted")) return null;
    return new SharedRepo(repoId, path, str(r["name"]), mode, Array.isArray(r["branches"]) ? strs(r["branches"]) : null, Array.isArray(r["allow"]) ? strs(r["allow"]) : null);
  }
}

export class Registry {
  readonly file: string;
  peers: Peer[] = [];
  repos: SharedRepo[] = [];

  constructor(file: string) {
    this.file = file;
  }

  /** Read the file; a missing or unreadable file is an empty registry. */
  load(): void {
    this.peers = [];
    this.repos = [];
    if (!existsSync(this.file)) return;
    const r = recordOf(parseJson(readFileSync(this.file, "utf8")));
    if (r === null) return;
    for (const v of listOf(r["peers"])) {
      const p = Peer.parse(v);
      if (p !== null) this.peers.push(p);
    }
    for (const v of listOf(r["repos"])) {
      const s = SharedRepo.parse(v);
      if (s !== null) this.repos.push(s);
    }
  }

  save(): void {
    writeAtomic(this.file, JSON.stringify(this.toJson(), null, 2) + "\n");
    chmodSync(this.file, 0o600);
  }

  toJson(): unknown {
    const v: unknown = { peers: this.peers.map((p: Peer) => p.toJson()), repos: this.repos.map((s: SharedRepo) => s.toJson()) };
    return v;
  }

  peerById(id: string): Peer | null {
    for (const p of this.peers) if (p.id === id) return p;
    return null;
  }

  /** The peer presenting `token`, compared in constant time against every peer's. */
  peerByToken(token: string): Peer | null {
    let found: Peer | null = null;
    for (const p of this.peers) if (sameSecret(p.tokenTheyPresent, token)) found = p;
    return found;
  }

  /** The peer named `name` (as a remote is named after it), else by id. */
  peerNamed(name: string): Peer | null {
    for (const p of this.peers) if (p.name === name) return p;
    return this.peerById(name);
  }

  upsertPeer(peer: Peer): void {
    this.peers = this.peers.filter((p: Peer) => p.id !== peer.id);
    this.peers.push(peer);
  }

  removePeer(id: string): boolean {
    const before = this.peers.length;
    this.peers = this.peers.filter((p: Peer) => p.id !== id);
    return this.peers.length < before;
  }

  repoByKey(key: string): SharedRepo | null {
    for (const s of this.repos) if (s.key === key) return s;
    return null;
  }

  /** The live checkout identified by `repoId` (what another machine's copy matches). */
  repoById(repoId: string): SharedRepo | null {
    for (const s of this.repos) if (!s.hosted && s.repoId === repoId && repoId.length > 0) return s;
    return null;
  }

  repoByPath(path: string): SharedRepo | null {
    for (const s of this.repos) if (s.path === path) return s;
    return null;
  }

  /** Whether `peer` may fetch `repo`: on the allow list, or there is none. */
  allows(repo: SharedRepo, peer: Peer): boolean {
    return repo.allow === null || repo.allow.includes(peer.id);
  }

  /** The repositories `peer` may see. */
  reposFor(peer: Peer): SharedRepo[] {
    return this.repos.filter((s: SharedRepo) => this.allows(s, peer));
  }

  /** Share `repo`, replacing what shared the same key or the same path. */
  share(repo: SharedRepo): void {
    this.repos = this.repos.filter((s: SharedRepo) => s.key !== repo.key && s.path !== repo.path);
    this.repos.push(repo);
  }

  unshare(key: string): boolean {
    const before = this.repos.length;
    this.repos = this.repos.filter((s: SharedRepo) => s.key !== key);
    return this.repos.length < before;
  }
}
