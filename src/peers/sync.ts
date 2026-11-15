// What a peer has that this machine does not, repository by repository: for each repository a peer
// offers that this machine shares too (the same root commit), the peer's copy is a remote of the
// local checkout, named after the peer, fetched here (refs only, the working tree untouched), and
// the local checkout's current branch is counted against the peer's branch of the same name, with
// the commits that are new over there listed. A repository the peer offers that this machine has
// no share of is listed as such, with the URL to clone it from.
import { ProcessRun, SpawnOptions, spawnCapped } from "@light/lib/process.ts";
import { urlHost } from "./git-http.ts";
import { Peer, SharedRepo } from "./registry.ts";

export const FRESH_MAX = 30;

/** The name a peer's remote takes in a checkout: the peer's name, kept to what git accepts. */
export const remoteNameOf = (peerName: string, peerId: string): string => {
  const clean = peerName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return clean.length > 0 ? clean : "peer-" + peerId.slice(0, 8);
};

/** The base URL of a peer's daemon, what its remotes' URLs start with and the key its token is kept under. */
export const peerBase = (peer: Peer): string => "http://" + urlHost(peer.address) + ":" + String(peer.port) + "/";

export class FreshCommit {
  readonly short: string;
  readonly subject: string;

  constructor(short: string, subject: string) {
    this.short = short;
    this.subject = subject;
  }

  toJson(): unknown {
    const v: unknown = { short: this.short, subject: this.subject };
    return v;
  }
}

/** One repository a peer offers, against this machine's copy when there is one. */
export class RepoSync {
  readonly key: string;
  readonly name: string;
  readonly repoId: string;
  readonly mode: string;
  /** This machine's checkout of it ("" for none). */
  readonly local: string;
  /** The remote the peer's copy is known as in that checkout ("" without one). */
  remote = "";
  /** The local checkout's current branch, what the counts are about. */
  branch = "";
  /** Whether the peer has that branch. */
  theirsHasBranch = false;
  /** Commits the local branch has that the peer's lacks, and the reverse (-1 when not counted). */
  ahead = -1;
  behind = -1;
  /** The commits new on the peer's side, newest first, at most FRESH_MAX. */
  fresh: FreshCommit[] = [];
  /** The peer's branches, by name. */
  theirBranches: string[] = [];
  fetchedMs = 0;
  error = "";

  constructor(key: string, name: string, repoId: string, mode: string, local: string) {
    this.key = key;
    this.name = name;
    this.repoId = repoId;
    this.mode = mode;
    this.local = local;
  }

  toJson(): unknown {
    const v: unknown = {
      key: this.key,
      name: this.name,
      repoId: this.repoId,
      mode: this.mode,
      local: this.local,
      remote: this.remote,
      branch: this.branch,
      theirsHasBranch: this.theirsHasBranch,
      ahead: this.ahead,
      behind: this.behind,
      fresh: this.fresh.map((c: FreshCommit) => c.toJson()),
      theirBranches: this.theirBranches,
      fetchedMs: this.fetchedMs,
      error: this.error,
    };
    return v;
  }
}

/** A peer's repositories as last synced. */
export class PeerSync {
  atMs = 0;
  running = false;
  /** The run in flight while `running`; a second asker waits for it. */
  job: Promise<PeerSync> | null = null;
  error = "";
  repos: RepoSync[] = [];

  toJson(): unknown {
    const v: unknown = { atMs: this.atMs, running: this.running, error: this.error, repos: this.repos.map((r: RepoSync) => r.toJson()) };
    return v;
  }
}

const gitIn = async (git: string, path: string, args: string[], timeoutMs: number): Promise<ProcessRun> => {
  const o = new SpawnOptions();
  o.timeoutMs = timeoutMs;
  return spawnCapped("env", ["GIT_TERMINAL_PROMPT=0", git, "-c", "credential.helper=", "-C", path, ...args], o);
};

/**
 * The peer's copy at `url` as the remote `name` of the checkout at `path`, its token under the
 * peer's base URL in that checkout's config (never in the URL). Answers "" or why git refused.
 */
export const ensureRemote = async (git: string, path: string, name: string, url: string, base: string, token: string): Promise<string> => {
  const had = await gitIn(git, path, ["config", "--get", "remote." + name + ".url"], 10000);
  if (had.code !== 0) {
    const added = await gitIn(git, path, ["remote", "add", name, url], 10000);
    if (added.code !== 0) return added.err.length > 0 ? added.err : "cannot add the remote " + name;
  } else if (had.text.trim() !== url) {
    const moved = await gitIn(git, path, ["remote", "set-url", name, url], 10000);
    if (moved.code !== 0) return moved.err.length > 0 ? moved.err : "cannot point the remote " + name + " at " + url;
  }
  await gitIn(git, path, ["config", "--unset-all", "http." + base + ".extraHeader"], 10000);
  const set = await gitIn(git, path, ["config", "--add", "http." + base + ".extraHeader", "Authorization: Bearer " + token], 10000);
  return set.code === 0 ? "" : set.err.length > 0 ? set.err : "cannot keep the token in the config";
};

/** The current branch of the checkout at `path` ("" when detached or unreadable). */
export const currentBranchOf = async (git: string, path: string): Promise<string> => {
  const run = await gitIn(git, path, ["symbolic-ref", "--quiet", "--short", "HEAD"], 10000);
  return run.ok ? run.text.trim() : "";
};

/** What the peer offers, parsed from its `/repos` answer. */
export class Offer {
  readonly key: string;
  readonly repoId: string;
  readonly name: string;
  readonly mode: string;
  readonly branches: string[];

  constructor(key: string, repoId: string, name: string, mode: string, branches: string[]) {
    this.key = key;
    this.repoId = repoId;
    this.name = name;
    this.mode = mode;
    this.branches = branches;
  }
}

export const parseOffers = (v: unknown): Offer[] => {
  const out: Offer[] = [];
  const root = typeof v === "object" && v !== null ? (v as { repos?: unknown }) : {};
  if (!Array.isArray(root.repos)) return out;
  for (const item of root.repos as unknown[]) {
    const r = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const key = typeof r["key"] === "string" ? r["key"] : "";
    if (key.length === 0) continue;
    const branches: string[] = [];
    if (Array.isArray(r["branches"])) for (const b of r["branches"] as unknown[]) if (typeof b === "object" && b !== null && typeof (b as { name?: unknown }).name === "string") branches.push((b as { name: string }).name);
    out.push(new Offer(key, typeof r["repoId"] === "string" ? r["repoId"] : "", typeof r["name"] === "string" ? r["name"] : key, typeof r["mode"] === "string" ? r["mode"] : "live", branches));
  }
  return out;
};

/**
 * The peer's offers against this machine's live shares: one RepoSync per offer, fetched into the
 * local checkout where there is one, with the counts and the fresh commits of its current branch.
 * A hosted mirror the peer offers beside a live copy of the same repository is listed as what it
 * is (a push target) and not compared: the peer's remote in the local checkout points at the live copy.
 */
export const syncOffers = async (git: string, peer: Peer, offers: Offer[], shares: SharedRepo[], onLog: ((line: string) => void) | null): Promise<RepoSync[]> => {
  const liveIds = new Set<string>();
  for (const o of offers) if (o.mode === "live" && o.repoId.length > 0) liveIds.add(o.repoId);
  const out: RepoSync[] = [];
  const base = peerBase(peer);
  const remote = remoteNameOf(peer.name, peer.id);
  for (const o of offers) {
    const mirrored = o.mode === "hosted" && liveIds.has(o.repoId);
    const share = mirrored ? undefined : shares.find((s: SharedRepo) => !s.hosted && s.repoId.length > 0 && s.repoId === o.repoId);
    const r = new RepoSync(o.key, o.name, o.repoId, o.mode, share !== undefined ? share.path : "");
    r.theirBranches = o.branches;
    out.push(r);
    if (share === undefined) continue;
    r.remote = remote;
    const why = await ensureRemote(git, share.path, remote, base + o.key, base, peer.tokenWePresent);
    if (why.length > 0) {
      r.error = why;
      continue;
    }
    const fetched = await gitIn(git, share.path, ["fetch", "--prune", remote], 180000);
    r.fetchedMs = Date.now();
    if (!fetched.ok) {
      r.error = (fetched.error.length > 0 ? fetched.error : fetched.err).split("\n")[0].slice(0, 160);
      if (onLog !== null) onLog("sync " + peer.name + " " + o.name + ": " + r.error);
      continue;
    }
    r.branch = await currentBranchOf(git, share.path);
    if (r.branch.length === 0) continue;
    r.theirsHasBranch = o.branches.includes(r.branch);
    if (!r.theirsHasBranch) continue;
    const theirs = remote + "/" + r.branch;
    const counts = await gitIn(git, share.path, ["rev-list", "--left-right", "--count", r.branch + "..." + theirs], 20000);
    const parts = counts.text.trim().split(/\s+/);
    if (counts.ok && parts.length >= 2) {
      r.ahead = Number(parts[0]);
      r.behind = Number(parts[1]);
    }
    if (r.behind > 0) {
      const log = await gitIn(git, share.path, ["log", "--format=%h%x09%s", "-n", String(FRESH_MAX), r.branch + ".." + theirs], 20000);
      if (log.ok)
        for (const line of log.text.split("\n")) {
          const tab = line.indexOf("\t");
          if (tab > 0) r.fresh.push(new FreshCommit(line.slice(0, tab), line.slice(tab + 1)));
        }
    }
    if (onLog !== null) onLog("sync " + peer.name + " " + o.name + " on " + r.branch + ": behind " + String(r.behind) + " ahead " + String(r.ahead));
  }
  return out;
};
