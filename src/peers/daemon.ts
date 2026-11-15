// The daemon: one per machine, the widecode binary run with --peers-daemon. It listens on the LAN
// for peers (pairing without a token while a code is shown; everything else with one) and on the
// loopback for the sessions of this machine (the control API behind its own token, in the state
// file). It keeps the identity and the registry, computes a repository's id (its oldest root
// commit) when one is shared, and goes away when its state file is removed or on SIGTERM.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { basename, join } from "node:path";
import { writeAtomic } from "@lightstart/lib/fs.ts";
import { errorMessage, listOf, num, parseJson, recordOf, str, strs } from "@lightstart/lib/json.ts";
import { ProcessRun, SpawnOptions, spawnCapped } from "@lightstart/lib/process.ts";
import { GitServer, bearerOf, isPrivateAddress, json, plain, remoteAddressOf, RequestUrl, urlHost } from "./git-http.ts";
import { Identity, loadOrCreateIdentity, newToken, saveIdentity } from "./identity.ts";
import { JoinRequest, PairOffer, acceptJoin, joinPeer, newPairCode } from "./pairing.ts";
import { Peer, Registry, SharedRepo } from "./registry.ts";
import { Advertiser, Browser, Seen } from "./discovery.ts";
import { peerRequest } from "./peer-request.ts";
import { Offer, PeerSync, RepoSync, ensureRemote, parseOffers, peerBase, remoteNameOf, syncOffers } from "./sync.ts";

export const DEFAULT_PORT = 7337;
const MAX_BODY = 1048576;
/** A peer seen within this long is online. */
export const ONLINE_MS = 180000;

/** Where the bridge keeps its files under the store. */
export class DaemonPaths {
  readonly dir: string;
  readonly identity: string;
  readonly registry: string;
  readonly state: string;
  readonly hosted: string;

  constructor(storeRoot: string) {
    this.dir = join(storeRoot, "peers");
    this.identity = join(this.dir, "identity.json");
    this.registry = join(this.dir, "peers.json");
    this.state = join(this.dir, "daemon.json");
    this.hosted = join(this.dir, "hosted");
  }
}

export class DaemonOptions {
  /** The LAN port asked for; another is taken when it is busy. */
  port = DEFAULT_PORT;
  /** The address the LAN listener binds: every interface, or the loopback alone (tests). */
  bind = "0.0.0.0";
  /** The name to announce; "" keeps the identity's. */
  name = "";
  git = "git";
  /** Announce this machine and look for the others over mDNS (avahi, dns-sd); off, peers are reached by typed addresses only. */
  discovery = true;
  /** How often the network is browsed, in ms. */
  browseMs = 30000;
  /** How often each online peer's repositories are synced (fetched into this machine's shared checkouts), in ms; 0 leaves that to the sessions' asking. */
  syncMs = 120000;
}

/** The state file: how a session finds the running daemon. */
export class DaemonState {
  readonly pid: number;
  readonly port: number;
  readonly localPort: number;
  readonly token: string;
  readonly startedMs: number;

  constructor(pid: number, port: number, localPort: number, token: string, startedMs: number) {
    this.pid = pid;
    this.port = port;
    this.localPort = localPort;
    this.token = token;
    this.startedMs = startedMs;
  }

  toJson(): unknown {
    const v: unknown = { pid: this.pid, port: this.port, localPort: this.localPort, token: this.token, startedMs: this.startedMs };
    return v;
  }

  static parse(text: string): DaemonState | null {
    const r = recordOf(parseJson(text));
    if (r === null) return null;
    const pid = num(r["pid"], 0);
    const localPort = num(r["localPort"], 0);
    const token = str(r["token"]);
    if (pid <= 0 || localPort <= 0 || token.length === 0) return null;
    return new DaemonState(pid, num(r["port"], 0), localPort, token, num(r["startedMs"], 0));
  }
}

export const readDaemonState = (paths: DaemonPaths): DaemonState | null => (existsSync(paths.state) ? DaemonState.parse(readFileSync(paths.state, "utf8")) : null);

/** Whether the daemon a state file names is there: its process lives and its control API answers with the file's token. */
export const daemonAnswers = async (state: DaemonState): Promise<boolean> => {
  if (!processAlive(state.pid)) return false;
  try {
    const res = await fetch("http://127.0.0.1:" + String(state.localPort) + "/api/state", { headers: { authorization: "Bearer " + state.token } });
    return res.status === 200;
  } catch {
    return false;
  }
};

/** Whether the process a state file names is alive. */
export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The machine's private IPv4 addresses, for the pairing screen. */
export const lanAddresses = (): string[] => {
  const out: string[] = [];
  const all = networkInterfaces();
  for (const name of Object.keys(all)) {
    const list = all[name];
    if (list === undefined) continue;
    for (const i of list) if (i.family === "IPv4" && !i.internal && isPrivateAddress(i.address)) out.push(i.address);
  }
  return out;
};

const listenOn = (server: Server, port: number, host: string): Promise<number> =>
  new Promise((resolve) => {
    let settled = false;
    const done = (p: number): void => {
      if (settled) return;
      settled = true;
      resolve(p);
    };
    server.on("error", () => done(0));
    server.listen(port, host, () => {
      const address = server.address();
      done(address !== null && typeof address === "object" ? address.port : 0);
    });
  });

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => resolve(size > MAX_BODY ? "" : Buffer.concat(chunks).toString("utf8")));
  });

export class Daemon {
  readonly paths: DaemonPaths;
  readonly identity: Identity;
  readonly registry: Registry;
  readonly gitServer: GitServer;
  readonly localToken = newToken();
  readonly startedMs = Date.now();
  git = "git";
  offer: PairOffer | null = null;
  port = 0;
  localPort = 0;
  /** Machines announcing themselves that are not paired with this one. */
  nearby: Seen[] = [];
  readonly advertiser = new Advertiser();
  readonly browser = new Browser();
  /** Each peer's repositories as last synced, by peer id. */
  readonly syncs = new Map<string, PeerSync>();
  private browsing: ReturnType<typeof setInterval> | null = null;
  private syncing: ReturnType<typeof setInterval> | null = null;
  private syncMs = 0;
  private lan: Server | null = null;
  private local: Server | null = null;
  private stateWritten = false;
  /** Hears a line for the log. */
  onLog: ((line: string) => void) | null = null;
  /** Hears that the daemon stopped (the state file went away, or stop was asked). */
  onStop: (() => void) | null = null;

  constructor(paths: DaemonPaths, identity: Identity, registry: Registry) {
    this.paths = paths;
    this.identity = identity;
    this.registry = registry;
    this.gitServer = new GitServer(registry);
    this.gitServer.onLog = (line: string) => this.note(line);
  }

  note(line: string): void {
    const fn = this.onLog;
    if (fn !== null) fn(line);
  }

  /** Listen on the LAN and on the loopback, then write the state file. */
  async start(o: DaemonOptions): Promise<string> {
    this.git = o.git;
    this.gitServer.git = o.git;
    if (o.name.length > 0 && o.name !== this.identity.name) {
      this.identity.name = o.name;
      saveIdentity(this.paths.identity, this.identity);
    }
    let lan = createServer((req: IncomingMessage, res: ServerResponse) => this.lanRequest(req, res));
    let port = await listenOn(lan, o.port, o.bind);
    if (port === 0 && o.port !== 0) {
      lan.close();
      lan = createServer((req: IncomingMessage, res: ServerResponse) => this.lanRequest(req, res));
      port = await listenOn(lan, 0, o.bind);
    }
    if (port === 0) return "cannot listen on the LAN";
    this.lan = lan;
    this.port = port;
    const local = createServer((req: IncomingMessage, res: ServerResponse) => {
      void this.localRequest(req, res);
    });
    const localPort = await listenOn(local, 0, "127.0.0.1");
    if (localPort === 0) {
      lan.close();
      return "cannot listen on the loopback";
    }
    this.local = local;
    this.localPort = localPort;
    mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 });
    writeAtomic(this.paths.state, JSON.stringify(new DaemonState(process.pid, port, localPort, this.localToken, this.startedMs).toJson(), null, 2) + "\n");
    chmodSync(this.paths.state, 0o600);
    this.stateWritten = true;
    this.note("listening on " + o.bind + ":" + String(port) + ", control on 127.0.0.1:" + String(localPort) + ", id " + this.identity.id.slice(0, 8) + " " + this.identity.name);
    if (o.discovery) {
      this.advertiser.onLog = (line: string) => this.note(line);
      this.advertiser.start(this.identity.id, this.identity.name, port);
      void this.browse();
      this.browsing = setInterval(() => {
        void this.browse();
      }, o.browseMs);
    }
    this.syncMs = o.syncMs;
    if (o.syncMs > 0)
      this.syncing = setInterval(() => {
        void this.syncDue(Date.now());
      }, Math.max(10000, Math.min(o.syncMs, 60000)));
    return "";
  }

  /** Every online peer whose last sync is older than the interval, synced one after another. */
  async syncDue(nowMs: number): Promise<void> {
    for (const p of this.registry.peers) {
      if (nowMs - p.lastSeenMs > ONLINE_MS) continue;
      const had = this.syncs.get(p.id);
      if (had !== undefined && (had.running || nowMs - had.atMs < this.syncMs)) continue;
      await this.syncPeer(p, "");
    }
  }

  /**
   * `peer`'s repositories against this machine's: its offers read, each one this machine shares a
   * live copy of fetched into that checkout (as a remote named after the peer, its token in the
   * checkout's config), the current branch counted against theirs. `key` limits it to one offer, the
   * others keeping their last state. A second asker waits for the sync in flight.
   */
  async syncPeer(peer: Peer, key: string): Promise<PeerSync> {
    let sync = this.syncs.get(peer.id);
    if (sync === undefined) {
      sync = new PeerSync();
      this.syncs.set(peer.id, sync);
    }
    if (sync.running && sync.job !== null) return sync.job;
    const job = this.runSync(peer, key, sync);
    sync.job = job;
    return job;
  }

  private async runSync(peer: Peer, key: string, sync: PeerSync): Promise<PeerSync> {
    sync.running = true;
    try {
      const text = await this.peerRepos(peer);
      if (text.length === 0) {
        sync.error = peer.name + " did not answer";
        return sync;
      }
      this.seen(peer.id, "", 0, Date.now());
      const offers = parseOffers(parseJson(text)).filter((o: Offer) => key.length === 0 || o.key === key);
      const fresh = await syncOffers(this.git, peer, offers, this.registry.repos, (line: string) => this.note(line));
      sync.repos = key.length === 0 ? fresh : sync.repos.filter((r: RepoSync) => r.key !== key).concat(fresh);
      sync.error = "";
      sync.atMs = Date.now();
    } finally {
      sync.running = false;
      sync.job = null;
    }
    return sync;
  }

  /**
   * `peer`'s offer at `key` cloned to `path` (an absent or empty directory), the peer's copy as the
   * clone's origin named after it, its token in the clone's config, the clone shared live here and
   * synced. Answers the share, or why not.
   */
  async clone(peer: Peer, key: string, path: string): Promise<SharedRepo | string> {
    if (path.length === 0 || !path.startsWith("/")) return "an absolute path is needed";
    if (existsSync(path) && readdirSync(path).length > 0) return path + " exists and is not empty";
    if (peer.address.length === 0 || peer.port <= 0) return peer.name + " has no address yet";
    const base = peerBase(peer);
    const remote = remoteNameOf(peer.name, peer.id);
    const o = new SpawnOptions();
    o.timeoutMs = 600000;
    const run = await spawnCapped("env", ["GIT_TERMINAL_PROMPT=0", this.git, "-c", "credential.helper=", "-c", "http." + base + ".extraHeader=Authorization: Bearer " + peer.tokenWePresent, "clone", "--origin", remote, base + key, path], o);
    if (!run.ok) return (run.error.length > 0 ? run.error : run.err).split("\n").filter((l: string) => l.length > 0).pop() ?? "git clone failed";
    const kept = await ensureRemote(this.git, path, remote, base + key, base, peer.tokenWePresent);
    if (kept.length > 0) return kept;
    const shared = await this.share(path, "", "live", null, null);
    if (typeof shared === "string") return shared;
    this.note("cloned " + peer.name + "'s " + key + " to " + path);
    await this.syncPeer(peer, "");
    return shared;
  }

  /** One look at the network: paired machines seen are marked, the others listed as nearby. */
  async browse(): Promise<void> {
    const found = await this.browser.browse();
    this.noteSeen(found, Date.now());
  }

  /** What a browse found, taken in: a paired peer's address, port and time move; an unknown id is nearby. */
  noteSeen(found: Seen[], nowMs: number): void {
    const nearby: Seen[] = [];
    for (const s of found) {
      if (s.id === this.identity.id || s.id.length === 0) continue;
      if (this.registry.peerById(s.id) !== null) this.seen(s.id, s.address, s.port, nowMs);
      else nearby.push(s);
    }
    this.nearby = nearby;
  }

  /** `address` as typed: a paired or nearby machine's name stands for its address and port. */
  resolveTarget(address: string, port: number): { address: string; port: number } {
    const peer = this.registry.peerNamed(address);
    if (peer !== null && peer.address.length > 0) return { address: peer.address, port: peer.port > 0 ? peer.port : port };
    for (const s of this.nearby) if (s.name === address || s.id === address || s.id.startsWith(address) || s.host === address) return { address: s.address, port: s.port > 0 ? s.port : port };
    return { address, port };
  }

  /** Whether the state file is still ours (a stop removes it; another daemon may have replaced it). */
  ownsState(): boolean {
    const s = readDaemonState(this.paths);
    return s !== null && s.pid === process.pid && s.token === this.localToken;
  }

  stop(): void {
    if (this.syncing !== null) {
      clearInterval(this.syncing);
      this.syncing = null;
    }
    this.advertiser.stop();
    if (this.browsing !== null) clearInterval(this.browsing);
    this.browsing = null;
    const lan = this.lan;
    const local = this.local;
    this.lan = null;
    this.local = null;
    if (lan !== null) lan.close();
    if (local !== null) local.close();
    if (this.stateWritten && this.ownsState()) rmSync(this.paths.state, { force: true });
    this.stateWritten = false;
    const fn = this.onStop;
    if (fn !== null) fn();
  }

  pairStart(nowMs: number): PairOffer {
    const offer = new PairOffer(newPairCode(), nowMs);
    this.offer = offer;
    this.note("pairing: code shown, live " + String(Math.round((offer.expiresMs - nowMs) / 1000)) + " s");
    return offer;
  }

  pairCancel(): void {
    this.offer = null;
  }

  /** Join the host at `address:port` (or a nearby machine's name) with `code`: the peer recorded, or why not. */
  pairJoin(address: string, port: number, code: string, nowMs: number): Promise<Peer | string> {
    const target = this.resolveTarget(address, port);
    return joinPeer(this.registry, this.identity, this.port, target.address, target.port, code, nowMs);
  }

  /** The oldest root commit of the repository at `path`, "" when it is not one (or has no commit). */
  async rootCommitOf(path: string): Promise<string> {
    const o = new SpawnOptions();
    o.timeoutMs = 20000;
    const run: ProcessRun = await spawnCapped(this.git, ["-C", path, "rev-list", "--max-parents=0", "HEAD"], o);
    if (!run.ok) return "";
    const lines = run.text.split("\n").filter((l: string) => l.trim().length > 0);
    return lines.length > 0 ? lines[lines.length - 1].trim() : "";
  }

  /** The root of the checkout holding `path`, "" when git does not say. */
  async toplevelOf(path: string): Promise<string> {
    const o = new SpawnOptions();
    o.timeoutMs = 10000;
    const run: ProcessRun = await spawnCapped(this.git, ["-C", path, "rev-parse", "--show-toplevel"], o);
    return run.ok ? run.text.trim() : "";
  }

  async isBare(path: string): Promise<boolean> {
    const o = new SpawnOptions();
    o.timeoutMs = 10000;
    const run: ProcessRun = await spawnCapped(this.git, ["-C", path, "rev-parse", "--is-bare-repository"], o);
    return run.ok && run.text.trim() === "true";
  }

  /** Share the repository at `path`: the record, or why not. A hosted one must be bare; a live one must not. */
  async share(path: string, name: string, mode: string, branches: string[] | null, allow: string[] | null): Promise<SharedRepo | string> {
    if (!existsSync(path) || !statSync(path).isDirectory()) return "not a folder: " + path;
    const bare = await this.isBare(path);
    const repoId = await this.rootCommitOf(path);
    if (repoId.length === 0 && !(mode === "hosted" && bare)) return "not a git repository with a commit: " + path;
    if (mode === "hosted" && !bare) return "a hosted repository is a bare one; this is a checkout: " + path;
    if (mode !== "hosted" && bare) return "a bare repository is hosted, not served live: " + path;
    if (!bare) {
      const top = await this.toplevelOf(path);
      if (top.length > 0) path = top;
    }
    const label = name.length > 0 ? name : basename(path).replace(/\.git$/, "");
    if (mode === "hosted" && !/^[A-Za-z0-9._-]+$/.test(label)) return "a hosted repository's name is letters, digits, dots, dashes and underscores: " + label;
    const repo = new SharedRepo(repoId, path, label, mode, branches, allow);
    const had = this.registry.repoByKey(repo.key);
    if (had !== null && had.path !== path) return (repo.hosted ? "a hosted repository named " + label : "this repository") + " is already shared from " + had.path + "; unshare it first" + (repo.hosted ? "" : ", or host a bare mirror for a second copy");
    this.registry.share(repo);
    this.registry.save();
    this.note("sharing " + repo.key + " (" + label + ", " + repo.mode + ") at " + path);
    return repo;
  }

  /**
   * Host a bare repository named `name`: the one at `path`, or a new empty one made under the store's
   * hosted folder when `path` is "". Paired peers may push into it (the allow list applies).
   */
  async host(name: string, path: string): Promise<SharedRepo | string> {
    const label = name.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(label)) return "a hosted repository's name is letters, digits, dots, dashes and underscores" + (label.length > 0 ? ": " + label : "");
    let where = path;
    if (where.length === 0) {
      where = join(this.paths.hosted, label.endsWith(".git") ? label : label + ".git");
      if (!existsSync(where)) {
        mkdirSync(this.paths.hosted, { recursive: true, mode: 0o700 });
        const o = new SpawnOptions();
        o.timeoutMs = 20000;
        const run: ProcessRun = await spawnCapped(this.git, ["init", "-q", "--bare", where], o);
        if (!run.ok) return "cannot make " + where + ": " + (run.error.length > 0 ? run.error : run.err);
        this.note("made the bare repository " + where);
      }
    }
    return this.share(where, label.replace(/\.git$/, ""), "hosted", null, null);
  }

  /** A hosted repository that has a commit now (pushed since it was made) gets its root commit as its id. */
  async fillRepoIds(): Promise<void> {
    let changed = false;
    for (const s of this.registry.repos) {
      if (!s.hosted || s.repoId.length > 0) continue;
      const id = await this.rootCommitOf(s.path);
      if (id.length === 0) continue;
      s.repoId = id;
      changed = true;
    }
    if (changed) this.registry.save();
  }

  unshare(key: string): boolean {
    const gone = this.registry.unshare(key);
    if (gone) this.registry.save();
    return gone;
  }

  forget(peerId: string): boolean {
    const gone = this.registry.removePeer(peerId);
    if (gone) this.registry.save();
    this.syncs.delete(peerId);
    return gone;
  }

  /** A peer was seen at `address:port` (discovery, or a request of its own). */
  seen(peerId: string, address: string, port: number, nowMs: number): void {
    const p = this.registry.peerById(peerId);
    if (p === null) return;
    if (address.length > 0) p.address = address;
    if (port > 0) p.port = port;
    p.lastSeenMs = nowMs;
    this.registry.save();
  }

  /** Ask `peer` whether it is there (its `/ping`, two seconds at most); its last-seen time moves when it answers. */
  async pingPeer(peer: Peer, nowMs: number): Promise<boolean> {
    if (peer.address.length === 0 || peer.port <= 0) return false;
    const url = "http://" + urlHost(peer.address) + ":" + String(peer.port) + "/ping";
    const a = await peerRequest("GET", url, {}, null, 2500);
    if (!a.ok) this.note("ping " + peer.name + " at " + url + ": " + (a.error.length > 0 ? a.error : "status " + String(a.status)));
    else this.seen(peer.id, "", 0, nowMs);
    return a.ok;
  }

  /** Every peer pinged at once; the ids of those that answered. */
  async refreshPeers(nowMs: number): Promise<string[]> {
    const results = await Promise.all(this.registry.peers.map((p: Peer) => this.pingPeer(p, nowMs)));
    const online: string[] = [];
    this.registry.peers.forEach((p: Peer, i: number) => {
      if (results[i]) online.push(p.id);
    });
    return online;
  }

  /** What `peer` offers us (its `/repos`, with our token), as the JSON text it answered; "" when it did not. */
  async peerRepos(peer: Peer): Promise<string> {
    if (peer.address.length === 0 || peer.port <= 0) return "";
    const url = "http://" + urlHost(peer.address) + ":" + String(peer.port) + "/repos";
    const a = await peerRequest("GET", url, { authorization: "Bearer " + peer.tokenWePresent }, null, 15000);
    if (!a.ok) {
      this.note("repos of " + peer.name + " at " + url + ": " + (a.error.length > 0 ? a.error : "status " + String(a.status) + " " + a.text.trim().slice(0, 120)));
      return "";
    }
    return a.text;
  }

  /** The daemon as the sessions see it. */
  stateJson(nowMs: number): unknown {
    const peers = this.registry.peers.map((p: Peer) => p.toPublicJson());
    const repos = this.registry.repos.map((s: SharedRepo) => s.toJson());
    const offer = this.offer !== null && this.offer.live(nowMs) ? this.offer.toJson() : null;
    const nearby = this.nearby.map((s: Seen) => s.toJson());
    const syncs: unknown[] = [];
    for (const [peerId, sync] of this.syncs) syncs.push({ peerId, sync: sync.toJson() });
    const v: unknown = { id: this.identity.id, name: this.identity.name, port: this.port, addresses: lanAddresses(), startedMs: this.startedMs, discovery: this.advertiser.running, peers, repos, nearby, syncs, pairing: offer };
    return v;
  }

  private lanRequest(req: IncomingMessage, res: ServerResponse): void {
    const from = remoteAddressOf(req);
    if (from.length > 0 && !isPrivateAddress(from)) {
      this.note("refused " + from + " (not a private address)");
      return plain(res, 403, "the bridge serves the local network only");
    }
    const url = new RequestUrl(req.url ?? "/");
    if (url.path === "/pair") {
      if (req.method !== "POST") return plain(res, 405, "only POST");
      void readBody(req).then((text: string) => {
        const body = JoinRequest.parse(text);
        const answer = body === null ? null : acceptJoin(this.registry, this.identity, this.port, this.offer, Date.now(), body, from);
        if (answer === null) {
          this.note("pairing: a join from " + from + " refused");
          return plain(res, 403, this.offer === null ? "no pairing code is shown here" : "the code does not match");
        }
        this.offer = null;
        this.note("pairing: " + body!.name + " joined from " + from);
        json(res, 200, answer.toJson());
        const joined = this.registry.peerByToken(answer.tokenForYou);
        if (this.syncMs > 0 && joined !== null) setTimeout(() => void this.syncPeer(joined, ""), 1000);
      });
      return;
    }
    if (url.path === "/ping") return json(res, 200, { id: this.identity.id, name: this.identity.name });
    const token = bearerOf(req);
    const peer = token.length > 0 ? this.registry.peerByToken(token) : null;
    if (peer === null) {
      this.note("401 " + from + " " + url.path);
      return plain(res, 401, "unauthorized");
    }
    this.seen(peer.id, from, 0, Date.now());
    if (url.path === "/repos") {
      void this.fillRepoIds().then(() => {
        if (!this.gitServer.serve(req, res, peer)) plain(res, 404, "not found");
      });
      return;
    }
    if (!this.gitServer.serve(req, res, peer)) plain(res, 404, "not found");
  }

  private async localRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = bearerOf(req);
    if (token !== this.localToken) return plain(res, 401, "unauthorized");
    const url = new RequestUrl(req.url ?? "/");
    const now = Date.now();
    if (req.method === "GET" && url.path === "/api/state") {
      await this.fillRepoIds();
      return json(res, 200, this.stateJson(now));
    }
    if (req.method !== "POST") return plain(res, 405, "only POST");
    const body = recordOf(parseJson(await readBody(req))) ?? {};
    try {
      switch (url.path) {
        case "/api/pair/start":
          return json(res, 200, { pairing: this.pairStart(now).toJson(), port: this.port, addresses: lanAddresses() });
        case "/api/pair/cancel":
          this.pairCancel();
          return json(res, 200, { ok: true });
        case "/api/pair/join": {
          const r = await this.pairJoin(str(body["address"]), num(body["port"], DEFAULT_PORT), str(body["code"]), now);
          if (typeof r === "string") return json(res, 400, { error: r });
          this.note("pairing: joined " + r.name + " at " + r.address + ":" + String(r.port));
          if (this.syncMs > 0) void this.syncPeer(r, "");
          return json(res, 200, { peer: r.toPublicJson() });
        }
        case "/api/share": {
          const r = await this.share(str(body["path"]), str(body["name"]), str(body["mode"]), Array.isArray(body["branches"]) ? strs(body["branches"]) : null, Array.isArray(body["allow"]) ? strs(body["allow"]) : null);
          if (typeof r === "string") return json(res, 400, { error: r });
          return json(res, 200, { repo: r.toJson() });
        }
        case "/api/host": {
          const r = await this.host(str(body["name"]), str(body["path"]));
          if (typeof r === "string") return json(res, 400, { error: r });
          return json(res, 200, { repo: r.toJson() });
        }
        case "/api/unshare":
          return json(res, 200, { ok: this.unshare(str(body["key"])) });
        case "/api/forget":
          return json(res, 200, { ok: this.forget(str(body["peerId"])) });
        case "/api/seen":
          this.seen(str(body["id"]), str(body["address"]), num(body["port"], 0), now);
          return json(res, 200, { ok: true });
        case "/api/peers/refresh": {
          if (this.browsing !== null) await this.browse();
          return json(res, 200, { online: await this.refreshPeers(now), nearby: this.nearby.map((s: Seen) => s.toJson()) });
        }
        case "/api/peer/sync": {
          const peer = this.registry.peerById(str(body["peerId"]));
          if (peer === null) return json(res, 404, { error: "no such peer" });
          const sync = await this.syncPeer(peer, str(body["key"]));
          return json(res, sync.error.length > 0 && sync.atMs === 0 ? 502 : 200, { peerId: peer.id, sync: sync.toJson() });
        }
        case "/api/clone": {
          const peer = this.registry.peerById(str(body["peerId"]));
          if (peer === null) return json(res, 404, { error: "no such peer" });
          const r = await this.clone(peer, str(body["key"]), str(body["path"]));
          if (typeof r === "string") return json(res, 400, { error: r });
          return json(res, 200, { repo: r.toJson() });
        }
        case "/api/peer/repos": {
          const peer = this.registry.peerById(str(body["peerId"]));
          if (peer === null) return json(res, 404, { error: "no such peer" });
          const text = await this.peerRepos(peer);
          if (text.length === 0) return json(res, 502, { error: peer.name + " did not answer" });
          this.seen(peer.id, "", 0, now);
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
          res.end(text);
          return;
        }
        case "/api/rename": {
          const name = str(body["name"]).trim();
          if (name.length === 0) return json(res, 400, { error: "a name is needed" });
          this.identity.name = name;
          saveIdentity(this.paths.identity, this.identity);
          return json(res, 200, { ok: true });
        }
        case "/api/stop":
          json(res, 200, { ok: true });
          setTimeout(() => this.stop(), 50);
          return;
      }
    } catch (err) {
      return json(res, 500, { error: errorMessage(err, "error") });
    }
    plain(res, 404, "not found");
  }
}

/** A list of unknowns as peers' public records, for the client side. */
export const peersOf = (v: unknown): unknown[] => listOf(v);

/**
 * Start the machine's daemon over the store at `storeRoot`: the Daemon, or why not (another one
 * is running, or nothing could listen). The identity is made on the first start.
 */
export const startDaemon = async (storeRoot: string, o: DaemonOptions, onLog: ((line: string) => void) | null = null): Promise<Daemon | string> => {
  const paths = new DaemonPaths(storeRoot);
  const running = readDaemonState(paths);
  if (running !== null && (await daemonAnswers(running))) return "another daemon is running (pid " + String(running.pid) + ", port " + String(running.port) + ")";
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const identity = loadOrCreateIdentity(paths.identity, hostname().replace(/\.local$/, ""));
  const registry = new Registry(paths.registry);
  registry.load();
  const daemon = new Daemon(paths, identity, registry);
  daemon.onLog = onLog;
  const why = await daemon.start(o);
  return why.length > 0 ? why : daemon;
};
