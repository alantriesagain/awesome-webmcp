// Peers: the LAN git bridge's tab and segment. The tab is a short list: this machine with what it
// shares (◆ marks this folder's repository), then each machine paired with it (● online, ○ not)
// and, under it, every repository that machine offers with how this machine's copy stands against
// it (↓ what they have that we lack, ↑ what we have that they lack, level, or "not here" when this
// machine has no copy), then the machines nearby that are not paired, and, while a code is shown,
// the pairing code with its time left. The last row says what the keys do for the row under the
// cursor. The details live in the code column: the row under the cursor opens a page there (this
// machine's id, addresses, shares with their paths and the URLs peers use, the way another machine
// joins; a peer's address, remote and repositories; a repository's commits to fetch and how to take
// them). Enter opens the page, f fetches from the peer (or the one repository) under the cursor, c
// clones a repository this machine lacks beside this folder, s shares or unshares this folder, p
// shows a code, x forgets a peer, r reads again. `/peers` opens the tab; `/peers pair`, `/peers join
// <host[:port]> <code>`, `/peers share [path]`, `/peers unshare`, `/peers host <name|path>`,
// `/peers fetch <peer> [repo]`, `/peers clone <peer> <repo> [path]`, `/peers forget <peer>`,
// `/peers name <name>` and `/peers stop` do the same from the composer. The daemon
// (lightcode --peers-daemon) does the serving and the fetching: every shared checkout of this
// machine is fetched from each peer's copy (a remote named after the peer), so the counts are of the
// whole machine, not of this folder alone. Nothing here touches a working tree: a fetch writes refs only.

type Run = lightcode.Run;
type Row = lightcode.Row;

const T = lightcode.theme;
const u = lightcode.util;
const DIM = T.dim;
const SELECTED_BG = T.selected;
const DEFAULT_PORT = 7337;
const DEFAULT_REFRESH_MS = 10000;
const AUTO_FETCH_MS = 120000;
const ONLINE_MS = 180000;

interface RowSpec {
  kind: "section" | "gap" | "me" | "repo" | "share" | "peer" | "peer-repo" | "peer-note" | "nearby" | "code" | "hint" | "empty";
  section?: string;
  peer?: number;
  repo?: number;
  near?: number;
  text?: string;
}

/** `text` cut into lines of at most `cells`, at spaces where there are any. */
const wrap = (text: string, cells: number): string[] => {
  const out: string[] = [];
  let rest = text;
  while (u.width(rest) > cells) {
    let at = -1;
    for (let i = 0; i < rest.length && u.width(rest.slice(0, i)) <= cells; i++) if (rest[i] === " ") at = i;
    if (at <= 0) at = Math.max(1, cells);
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  out.push(rest);
  return out;
};

interface Shared {
  key: string;
  repoId: string;
  name: string;
  path: string;
  mode: string;
  branches: string[] | null;
  allow: string[] | null;
}

interface FreshCommit {
  short: string;
  subject: string;
}

/** A repository a peer offers, against this machine's copy as the daemon last synced it. */
interface RepoView {
  key: string;
  repoId: string;
  name: string;
  mode: string;
  /** This machine's checkout of it ("" for none). */
  local: string;
  remote: string;
  /** The local checkout's current branch, what the counts are about. */
  branch: string;
  theirsHasBranch: boolean;
  ahead: number;
  behind: number;
  fresh: FreshCommit[];
  theirBranches: string[];
  fetchedMs: number;
  error: string;
}

interface PeerView {
  id: string;
  name: string;
  address: string;
  port: number;
  lastSeenMs: number;
  online: boolean;
  repos: RepoView[];
  syncedMs: number;
  syncing: boolean;
  syncError: string;
}

interface Pairing {
  code: string;
  expiresMs: number;
}

/** A machine announcing itself on the network that is not paired with this one. */
interface Nearby {
  id: string;
  name: string;
  address: string;
  port: number;
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const strList = (v: unknown): string[] | null => (Array.isArray(v) ? (v as unknown[]).map((x) => u.str(x)) : null);

const sharedOf = (v: unknown): Shared => {
  const r = rec(v);
  return { key: u.str(r.key), repoId: u.str(r.repoId), name: u.str(r.name), path: u.str(r.path), mode: u.str(r.mode), branches: strList(r.branches), allow: strList(r.allow) };
};

const repoOf = (v: unknown): RepoView => {
  const r = rec(v);
  return {
    key: u.str(r.key),
    repoId: u.str(r.repoId),
    name: u.str(r.name),
    mode: u.str(r.mode),
    local: u.str(r.local),
    remote: u.str(r.remote),
    branch: u.str(r.branch),
    theirsHasBranch: r.theirsHasBranch === true,
    ahead: u.num(r.ahead, -1),
    behind: u.num(r.behind, -1),
    fresh: list(r.fresh).map((c) => ({ short: u.str(rec(c).short), subject: u.str(rec(c).subject) })),
    theirBranches: strList(r.theirBranches) ?? [],
    fetchedMs: u.num(r.fetchedMs, 0),
    error: u.str(r.error),
  };
};

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const commits = (n: number): string => String(n) + (n === 1 ? " commit" : " commits");

const hostPort = (arg: string): { address: string; port: number } => {
  const at = arg.lastIndexOf(":");
  if (at > 0 && /^[0-9]+$/.test(arg.slice(at + 1))) return { address: arg.slice(0, at), port: Number(arg.slice(at + 1)) };
  return { address: arg, port: DEFAULT_PORT };
};

lightcode.plugin({
  id: "peers",
  defaults: () => ({ autoFetch: true, refreshMs: DEFAULT_REFRESH_MS }),
  activate(api) {
    const section = rec(api.settings.section());
    const autoFetch = section.autoFetch !== false;
    const refreshMs = Math.max(2000, u.num(section.refreshMs, DEFAULT_REFRESH_MS));

    let me = { id: "", name: "", port: 0, addresses: [] as string[] };
    let shared: Shared[] = [];
    let peers: PeerView[] = [];
    let pairing: Pairing | null = null;
    let nearby: Nearby[] = [];
    let discovery = false;
    let daemon = "starting";
    let myRepoId = "";
    let rows: RowSpec[] = [];
    let selected = 0;
    let refreshing = false;
    const folded = new Set<string>();

    const req = (method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> => api.peers.request(method, path, body);

    const myShare = (): Shared | null => {
      for (const s of shared) if (s.mode === "live" && s.repoId === myRepoId && myRepoId.length > 0) return s;
      return null;
    };
    const isMine = (repoId: string): boolean => myRepoId.length > 0 && repoId === myRepoId;
    const peerNamed = (name: string): PeerView | null => {
      for (const p of peers) if (p.name === name || p.id === name || p.id.startsWith(name)) return p;
      return null;
    };
    const repoNamed = (p: PeerView, name: string): RepoView | null => {
      for (const r of p.repos) if (r.name === name || r.key === name) return r;
      return null;
    };
    /** A peer's repositories in the tab's order: this folder's first, then those this machine has, then the rest, by name. */
    const sortedRepos = (p: PeerView): RepoView[] => {
      const rank = (r: RepoView): number => (isMine(r.repoId) ? 0 : r.local.length > 0 ? 1 : 2);
      return p.repos.slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    };
    const behindOf = (p: PeerView): number => p.repos.reduce((n, r) => n + Math.max(0, r.behind), 0);

    /** What a repository row says on the right: how this machine's copy stands against the peer's. */
    const repoTag = (r: RepoView): { text: string; fg: string } => {
      if (r.error.length > 0) return { text: "!", fg: T.bad };
      if (r.local.length === 0) {
        if (isMine(r.repoId)) return { text: "share · s", fg: DIM };
        return { text: r.mode === "hosted" ? "hosted" : "not here", fg: DIM };
      }
      if (r.fetchedMs === 0) return { text: "", fg: "" };
      if (r.branch.length === 0) return { text: "detached", fg: DIM };
      if (!r.theirsHasBranch) return { text: "no " + r.branch, fg: DIM };
      if (r.behind > 0) return { text: "↓" + String(r.behind) + (r.ahead > 0 ? " ↑" + String(r.ahead) : ""), fg: T.warn };
      if (r.ahead > 0) return { text: "↑" + String(r.ahead), fg: T.ok };
      if (r.ahead === 0 && r.behind === 0) return { text: "level", fg: DIM };
      return { text: "", fg: "" };
    };

    /** A sentence on how this machine's copy stands against the peer's. */
    const standing = (r: RepoView): string => {
      if (r.error.length > 0) return "the last fetch failed: " + r.error;
      if (r.local.length === 0) return isMine(r.repoId) ? "this folder's repository, not shared yet: s shares it, and the daemon compares and fetches" : r.mode === "hosted" ? "a bare repository on their side that takes pushes" : "no copy on this machine";
      if (r.fetchedMs === 0) return "not fetched yet";
      if (r.branch.length === 0) return "HEAD is detached here, nothing to count against";
      if (!r.theirsHasBranch) return "they have no branch " + r.branch;
      const parts: string[] = [];
      if (r.behind > 0) parts.push("they have " + commits(r.behind) + " you do not");
      if (r.ahead > 0) parts.push("you have " + commits(r.ahead) + " they do not");
      return parts.length > 0 ? parts.join(" · ") : "level";
    };

    /** What a peer's row says on the right. */
    const peerTag = (p: PeerView): { text: string; fg: string } => {
      if (p.syncing) return { text: "…", fg: DIM };
      if (!p.online) return { text: "offline", fg: DIM };
      if (p.syncError.length > 0) return { text: "!", fg: T.bad };
      const behind = behindOf(p);
      if (behind > 0) return { text: "↓" + String(behind), fg: T.warn };
      if (p.syncedMs > 0) return { text: u.age(Date.now() - p.syncedMs), fg: DIM };
      return { text: "", fg: "" };
    };

    /** A short line under a peer's repositories: what went wrong, or that it offers nothing; "" for none. */
    const peerNote = (p: PeerView): string => {
      if (p.syncError.length > 0) return p.syncError;
      if (p.online && p.repos.length === 0 && p.syncedMs > 0) return "offers nothing yet";
      return "";
    };

    const layout = (): void => {
      const out: RowSpec[] = [];
      out.push({ kind: "section", section: "me" });
      if (!folded.has("me")) {
        out.push({ kind: "me" });
        shared.forEach((_s, i) => out.push({ kind: "repo", repo: i }));
        if (myShare() === null && myRepoId.length > 0 && daemon === "running") out.push({ kind: "share" });
      }
      out.push({ kind: "gap" });
      out.push({ kind: "section", section: "peers" });
      if (!folded.has("peers")) {
        if (peers.length === 0 && nearby.length === 0) out.push({ kind: "empty", text: "none paired yet" });
        peers.forEach((p, i) => {
          out.push({ kind: "peer", peer: i });
          sortedRepos(p).forEach((r) => out.push({ kind: "peer-repo", peer: i, text: r.key }));
          const note = peerNote(p);
          if (note.length > 0) out.push({ kind: "peer-note", peer: i, text: note });
        });
        nearby.forEach((_n, i) => out.push({ kind: "nearby", near: i }));
      }
      if (pairing !== null && pairing.expiresMs > Date.now()) {
        out.push({ kind: "gap" });
        out.push({ kind: "section", section: "pairing" });
        if (!folded.has("pairing")) out.push({ kind: "code" });
      }
      out.push({ kind: "gap" });
      out.push({ kind: "hint" });
      rows = out;
      if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    };

    /** The repository a `peer-repo` row stands for. */
    const repoAt = (r: RowSpec | undefined): { peer: PeerView; repo: RepoView } | null => {
      if (r === undefined || r.kind !== "peer-repo") return null;
      const p = peers[r.peer ?? 0];
      if (p === undefined) return null;
      for (const x of p.repos) if (x.key === r.text) return { peer: p, repo: x };
      return null;
    };

    const sectionTitle = (name: string): string => (name === "me" ? "This machine" : name === "peers" ? "Peers" + (peers.length > 0 ? " · " + String(peers.length) : "") : "Pairing");

    /** What the keys do for the row under the cursor, short enough for the narrowest tab. */
    const hintFor = (r: RowSpec | undefined): string => {
      if (r === undefined) return "↵ open · p pair";
      if (r.kind === "repo") return isMine(shared[r.repo ?? 0].repoId) && shared[r.repo ?? 0].mode === "live" ? "↵ open · s unshare" : "↵ open";
      if (r.kind === "share") return "↵ or s shares this folder";
      if (r.kind === "peer" || r.kind === "peer-note") return "↵ open · f fetch · x forget";
      if (r.kind === "peer-repo") {
        const at = repoAt(r);
        if (at === null) return "↵ open";
        if (at.repo.local.length > 0) return at.repo.behind > 0 ? "↵ commits · f fetch" : "↵ open · f fetch";
        if (isMine(at.repo.repoId)) return "↵ open · s share";
        return at.repo.mode === "hosted" ? "↵ open" : "↵ open · c clone";
      }
      if (r.kind === "nearby") return "↵ how to pair";
      if (r.kind === "code") return "↵ open · p new code";
      return peers.length > 0 ? "↵ open · f fetch · p pair" : "↵ open · p pair · s share";
    };

    /** A row: `lead`, `name` clipped to what is left, and a short `tag` on the right. */
    const pairRow = (bg: string, lead: Run, name: string, nameFg: string, bold: boolean, tag: string, tagFg: string, width: number): Row => {
      const room = Math.max(3, width - u.width(lead.text) - (tag.length > 0 ? u.width(tag) + 1 : 0));
      const shown = u.clip(name, room);
      const runs: Run[] = [lead, { text: shown, fg: nameFg, bold }];
      const pad = room - u.width(shown);
      if (pad > 0) runs.push({ text: " ".repeat(pad), fg: "" });
      if (tag.length > 0) runs.push({ text: " " + tag, fg: tagFg });
      return { bg, runs };
    };

    const line = (r: RowSpec, index: number, width: number): Row => {
      const bg = index === selected && r.kind !== "gap" ? SELECTED_BG : "";
      const now = Date.now();
      const plain = (text: string, fg: string): Row => ({ bg, runs: [{ text: "   " + u.clip(text, Math.max(1, width - 3)), fg }] });
      if (r.kind === "gap") return { bg: "", runs: [{ text: "", fg: "" }] };
      if (r.kind === "section") {
        const open = !folded.has(r.section ?? "");
        return { bg, runs: [{ text: " " + (open ? "▾ " : "▸ "), fg: DIM }, { text: u.clip(sectionTitle(r.section ?? ""), Math.max(1, width - 3)), fg: "", bold: true }] };
      }
      if (r.kind === "me") {
        if (daemon !== "running") return plain(daemon === "starting" ? "starting…" : daemon === "not running" ? "idle · Enter starts it" : daemon, T.warn);
        return pairRow(bg, { text: "   ", fg: "" }, me.name, "", false, ":" + String(me.port), DIM, width);
      }
      if (r.kind === "repo") {
        const s = shared[r.repo ?? 0];
        const mine = isMine(s.repoId) && s.mode === "live";
        return pairRow(bg, { text: "   " + (mine ? "◆ " : "• "), fg: mine ? T.link : DIM }, s.name, mine ? T.link : "", mine, s.mode === "hosted" ? "hosted" : "live", DIM, width);
      }
      if (r.kind === "share") return { bg, runs: [{ text: "   ○ ", fg: DIM }, { text: "share this folder", fg: T.link }, { text: "  s", fg: DIM }] };
      if (r.kind === "peer") {
        const p = peers[r.peer ?? 0];
        const tag = peerTag(p);
        return pairRow(bg, { text: "   " + (p.online ? "● " : "○ "), fg: p.online ? T.ok : DIM }, p.name, "", true, tag.text, tag.fg, width);
      }
      if (r.kind === "peer-repo") {
        const at = repoAt(r);
        if (at === null) return plain("", "");
        const mine = isMine(at.repo.repoId);
        const tag = repoTag(at.repo);
        const here = at.repo.local.length > 0 || mine;
        return pairRow(bg, { text: "     " + (mine ? "◆ " : "• "), fg: mine ? T.link : here ? "" : DIM }, at.repo.name, mine ? T.link : here ? "" : DIM, false, tag.text, tag.fg, width);
      }
      if (r.kind === "peer-note") return plain("  " + (r.text ?? ""), peers[r.peer ?? 0].syncError.length > 0 ? T.bad : DIM);
      if (r.kind === "nearby") return pairRow(bg, { text: "   ○ ", fg: DIM }, nearby[r.near ?? 0].name, "", false, "nearby", DIM, width);
      if (r.kind === "code") {
        const left = pairing !== null ? Math.max(0, Math.round((pairing.expiresMs - now) / 1000)) : 0;
        return { bg, runs: [{ text: "   ", fg: "" }, { text: pairing !== null ? pairing.code : "", fg: T.link, bold: true }, { text: "  " + String(Math.floor(left / 60)) + ":" + String(left % 60).padStart(2, "0"), fg: left < 20 ? T.warn : DIM }] };
      }
      if (r.kind === "hint") return plain(hintFor(rows[selected]), DIM);
      return plain(r.text ?? "", DIM);
    };

    let detailWidth = 80;

    /** The details page for the row under the cursor, `width` cells wide. */
    const detailRows = (width: number): Row[] => {
      const out: Row[] = [];
      const w = Math.max(20, width - 2);
      const put = (text: string, fg: string, bold?: boolean): void => {
        out.push({ runs: [{ text: " " + text, fg, bold }] });
      };
      const blank = (): void => put("", "");
      const field = (name: string, value: string, fg?: string): void => {
        if (value.length === 0) return;
        const parts = wrap(value, Math.max(10, w - 12));
        parts.forEach((part, i) => out.push({ runs: [{ text: " " + (i === 0 ? name.padEnd(11, " ") : "           "), fg: DIM }, { text: part, fg: fg ?? "" }] }));
      };
      const action = (key: string, text: string, ...why: string[]): void => {
        wrap(text, Math.max(10, w - 8)).forEach((part, i) => out.push({ runs: [{ text: i === 0 ? " › " : "   ", fg: DIM }, { text: (i === 0 ? key : "").padEnd(4, " "), fg: T.link, bold: true }, { text: part, fg: "" }] }));
        for (const line of why) for (const part of wrap(line, Math.max(10, w - 8))) put("       " + part, DIM);
      };
      const joinLine = (): string => "/peers join " + (me.addresses[0] ?? "<this machine's address>") + (me.port > 0 && me.port !== DEFAULT_PORT ? ":" + String(me.port) : "") + " " + (pairing !== null && pairing.expiresMs > Date.now() ? pairing.code : "<code>");
      const offerUrl = (p: PeerView, r: RepoView): string => "http://" + p.address + ":" + String(p.port) + "/" + r.key;
      const repoLine = (r: RepoView): void => {
        const mine = isMine(r.repoId);
        const tag = repoTag(r);
        out.push({ runs: [{ text: " " + (mine ? "◆ " : "• "), fg: mine ? T.link : DIM }, { text: u.clip(r.name, 24).padEnd(25, " "), fg: mine ? T.link : r.local.length > 0 ? "" : DIM }, { text: tag.text.padEnd(10, " "), fg: tag.fg }, { text: r.local.length > 0 ? (r.branch.length > 0 ? r.branch + "  " : "") + r.local : r.mode === "hosted" ? "hosted, takes pushes" : "live", fg: DIM }] });
      };
      const r = rows[selected];
      const kind = r === undefined ? "me" : r.kind;
      if (kind === "peer-repo") {
        const at = repoAt(r);
        if (at === null) return out;
        const p = at.peer;
        const x = at.repo;
        const mine = isMine(x.repoId);
        put(p.name + " · " + x.name, "", true);
        blank();
        field("theirs", (x.mode === "hosted" ? "a bare repository that takes pushes" : "a live checkout, read-only") + " · " + offerUrl(p, x));
        field("here", x.local.length > 0 ? x.local + (mine ? " (this folder)" : "") : mine ? "this folder, not shared yet" : "no copy on this machine", x.local.length > 0 || mine ? "" : DIM);
        if (x.remote.length > 0) field("remote", x.remote + ", in that checkout");
        if (x.branch.length > 0) field("branch", x.branch + (x.theirsHasBranch ? "" : " (not on their side)"));
        field("standing", standing(x), x.error.length > 0 ? T.bad : x.behind > 0 ? T.warn : "");
        if (x.fetchedMs > 0) field("fetched", u.age(Date.now() - x.fetchedMs) + " ago");
        if (x.fresh.length > 0) {
          blank();
          put("Commits to fetch (" + String(x.behind) + (x.fresh.length < x.behind ? ", the newest " + String(x.fresh.length) : "") + ")", DIM);
          for (const c of x.fresh) out.push({ runs: [{ text: "  " + c.short + "  ", fg: DIM }, { text: u.clip(c.subject, Math.max(10, w - 12)), fg: "" }] });
        }
        if (x.theirBranches.length > 0) {
          blank();
          put("Their branches: " + x.theirBranches.join(", "), DIM);
        }
        blank();
        if (x.local.length > 0) {
          action("f", "fetch it from " + p.name + " now");
          if (x.behind > 0 && x.remote.length > 0 && x.branch.length > 0) {
            if (mine) action("b", "in the Git tab, cycles the compare base to " + x.remote + "/" + x.branch + ": the diff and the log of what they have");
            action("", "to take their commits, in " + x.local + ":", "git merge " + x.remote + "/" + x.branch, "git rebase " + x.remote + "/" + x.branch);
          }
          if (x.ahead > 0 && x.mode === "hosted" && x.remote.length > 0 && x.branch.length > 0) action("", "to give them yours, in " + x.local + ":", "git push " + x.remote + " " + x.branch);
        } else if (mine) action("s", "share this folder's repository; the daemon then compares it with theirs and fetches");
        else if (x.mode !== "hosted") action("c", "clone it beside this folder, shared here once it is", "/peers clone " + p.name + " " + x.name + " [path] chooses the path");
        else action("", "to push into it, from a checkout here:", "git push " + offerUrl(p, x) + " <branch> (the token is in the config once that checkout is shared)");
        return out;
      }
      if (kind === "peer" || kind === "peer-note") {
        const p = peers[r?.peer ?? 0];
        put(p.name, "", true);
        blank();
        field("state", (p.online ? "online" : p.lastSeenMs > 0 ? "not seen for " + u.age(Date.now() - p.lastSeenMs) : "never seen") + (p.syncing ? " · fetching…" : ""), p.online ? T.ok : DIM);
        field("address", p.address.length > 0 ? p.address + ":" + String(p.port) : "unknown");
        field("id", p.id);
        if (p.syncedMs > 0) field("fetched", u.age(Date.now() - p.syncedMs) + " ago" + (p.syncError.length > 0 ? " · failed: " + p.syncError : ""), p.syncError.length > 0 ? T.bad : "");
        else if (p.syncError.length > 0) field("fetched", "never · " + p.syncError, T.bad);
        blank();
        if (p.repos.length === 0) put("Offers nothing yet" + (p.online ? "" : " that this machine has seen"), DIM);
        else {
          const behind = behindOf(p);
          put("Repositories (" + String(p.repos.length) + ")" + (behind > 0 ? " · " + commits(behind) + " to fetch" : ""), DIM);
          for (const x of sortedRepos(p)) repoLine(x);
        }
        blank();
        action("f", "fetch every repository it offers that this machine has");
        action("↵", "on a repository: its commits to fetch and how to take them");
        action("x", "forget it: its token stops opening this machine");
        return out;
      }
      if (kind === "nearby") {
        const n = nearby[r?.near ?? 0];
        put(n.name, "", true);
        blank();
        field("state", "announcing itself nearby, not paired", DIM);
        field("address", n.address + ":" + String(n.port));
        field("id", n.id);
        blank();
        put("To pair: on that machine, p (or /peers pair) shows a code; here, /peers join " + n.name + " <code>.", "");
        put("Or show a code here with p and join from there with " + joinLine() + ".", "");
        return out;
      }
      put(me.name.length > 0 ? me.name : "This machine", "", true);
      blank();
      if (daemon !== "running") {
        field("daemon", daemon === "starting" ? "starting…" : daemon === "not running" ? "not running: Enter on its row, or p or s, starts it" : daemon, T.warn);
        blank();
      } else {
        field("serving", ":" + String(me.port) + (me.addresses.length > 0 ? " on " + me.addresses.join(", ") : ""));
        field("announced", discovery ? "yes, over mDNS as _lightcode._tcp" : "no (discovery off, or no avahi or dns-sd)", discovery ? "" : DIM);
        field("id", me.id);
      }
      blank();
      put("Shared" + (shared.length > 0 ? " (" + String(shared.length) + ")" : ": nothing yet"), DIM);
      for (const sh of shared) {
        const mine = isMine(sh.repoId) && sh.mode === "live";
        out.push({ runs: [{ text: " " + (mine ? "◆ " : "• "), fg: mine ? T.link : DIM }, { text: u.clip(sh.name, 24).padEnd(25, " "), fg: mine ? T.link : "", bold: mine }, { text: sh.mode === "hosted" ? "hosted, takes pushes" : mine ? "live, this folder" : "live", fg: DIM }] });
        put("    " + sh.path, DIM);
        put("    " + (sh.branches !== null ? "branches " + sh.branches.join(", ") : "every branch") + " · " + (sh.allow !== null ? String(sh.allow.length) + " peers allowed" : "every paired peer"), DIM);
        put("    http://" + (me.addresses[0] ?? "<address>") + ":" + String(me.port) + "/" + sh.key, DIM);
      }
      blank();
      put("Pairing", DIM);
      if (pairing !== null && pairing.expiresMs > Date.now()) {
        const left = Math.max(0, Math.round((pairing.expiresMs - Date.now()) / 1000));
        out.push({ runs: [{ text: " code  ", fg: DIM }, { text: pairing.code, fg: T.link, bold: true }, { text: "  " + String(Math.floor(left / 60)) + ":" + String(left % 60).padStart(2, "0") + " left", fg: left < 20 ? T.warn : DIM }] });
        put("on the other machine: " + joinLine(), "");
      } else action("p", "show a code for two minutes; the other machine joins with " + joinLine());
      action("", "/peers join <host:port> <code>", "join a machine showing a code; a nearby machine's name works as the host");
      blank();
      put("Sharing", DIM);
      if (myShare() === null && myRepoId.length > 0 && daemon === "running") action("s", "share this folder's repository, live: paired machines fetch it, and this machine's copy is compared with theirs");
      else if (myShare() !== null) action("s", "stop sharing this folder's repository");
      action("", "/peers share <path>", "share another checkout of this machine");
      action("", "/peers host <name>", "a bare repository paired machines push into");
      action("", "/peers clone <peer> <repo> [path]", "a copy of what a peer offers that this machine lacks, shared here once cloned");
      blank();
      for (const part of wrap("Every shared checkout is fetched from each peer's copy (a remote named after the peer, refs only; no working tree is touched), so a row's ↓ counts what they have on its current branch that this machine lacks. A machine that cannot be reached while it sees this one has port " + String(me.port > 0 ? me.port : DEFAULT_PORT) + "/tcp closed by its firewall (on Linux with ufw: sudo ufw allow " + String(me.port > 0 ? me.port : DEFAULT_PORT) + "/tcp).", w)) put(part, DIM);
      return out;
    };

    const detail = api.code.view({
      id: "peers",
      count: () => detailRows(detailWidth).length,
      rows: (from, count, width) => {
        detailWidth = width;
        return detailRows(width).slice(from, from + count);
      },
    });

    const titleFor = (r: RowSpec | undefined): string => {
      if (r === undefined) return "Peers";
      if (r.kind === "peer" || r.kind === "peer-note") return "Peer · " + peers[r.peer ?? 0].name;
      if (r.kind === "peer-repo") {
        const at = repoAt(r);
        return at === null ? "Peers" : at.peer.name + " · " + at.repo.name;
      }
      if (r.kind === "nearby") return "Nearby · " + nearby[r.near ?? 0].name;
      return "Peers · this machine";
    };

    /** The page for the row under the cursor, in the code column (while this tab shows). */
    const showDetail = (): void => {
      if (api.state.active().panel !== "peers") return;
      detail.show(titleFor(rows[selected]));
    };

    const panel = api.ui.panel({
      id: "peers",
      title: "Peers",
      order: 3,
      width: (cols) => Math.max(30, Math.min(48, Math.floor(cols / 6))),
      count: () => rows.length,
      rows: (from, count, width) => rows.slice(from, from + count).map((r, i) => line(r, from + i, width)),
      badge: () => {
        const best = bestPeer();
        return best !== null ? [{ text: "↓" + String(behindOf(best)), fg: T.warn }] : [];
      },
      info: () => [{ text: " " + (daemon === "running" ? String(peers.filter((p) => p.online).length) + " online · sharing " + String(shared.length) : daemon === "starting" ? "starting the daemon…" : daemon === "not running" ? "idle" : daemon), fg: daemon === "running" ? DIM : T.warn }],
      press: (row) => {
        selected = row;
        panel.refresh();
        act("enter");
      },
      shown: () => {
        layout();
        panel.refresh();
        void refresh(true, true);
        panel.reveal(selected);
        showDetail();
      },
      hidden: () => {
        if (detail.shown()) api.code.open(api.code.path());
      },
    });

    /** The online peer with the most commits this machine lacks, over every repository; null when none has any. */
    const bestPeer = (): PeerView | null => {
      let best: PeerView | null = null;
      for (const p of peers) if (behindOf(p) > 0 && (best === null || behindOf(p) > behindOf(best))) best = p;
      return best;
    };

    api.ui.segment({
      name: "peers",
      draw: () => {
        if (daemon !== "running" || peers.length === 0) return [];
        const best = bestPeer();
        if (best !== null) return [{ text: best.name + " ↓" + String(behindOf(best)), fg: T.warn }];
        const online = peers.filter((p) => p.online).length;
        return [{ text: String(online) + "/" + String(peers.length) + " peers", fg: online > 0 ? T.ok : DIM }];
      },
      press: () => api.actions.showPanel("peers"),
    });

    const redraw = (): void => {
      layout();
      panel.refresh();
      if (detail.shown()) detail.refresh();
    };

    /** A peer's sync as the daemon answered it, taken into the view. */
    const applySync = (p: PeerView, v: unknown): void => {
      const s = rec(v);
      p.syncedMs = u.num(s.atMs, 0);
      p.syncError = u.str(s.error);
      if (s.running === true && p.syncedMs === 0) return;
      p.repos = list(s.repos).map(repoOf);
    };

    const readState = async (): Promise<boolean> => {
      const a = await req("GET", "/api/state");
      if (a.status !== 200) {
        daemon = a.status === 0 ? "not running" : "answered " + String(a.status);
        return false;
      }
      daemon = "running";
      const r = rec(parse(a.text));
      me = { id: u.str(r.id), name: u.str(r.name), port: u.num(r.port, 0), addresses: list(r.addresses).map((x) => u.str(x)) };
      discovery = r.discovery === true;
      shared = list(r.repos).map(sharedOf);
      nearby = list(r.nearby).map((v) => {
        const n = rec(v);
        return { id: u.str(n.id), name: u.str(n.name), address: u.str(n.address), port: u.num(n.port, 0) };
      });
      const pr = rec(r.pairing);
      pairing = u.str(pr.code).length > 0 ? { code: u.str(pr.code), expiresMs: u.num(pr.expiresMs, 0) } : null;
      const syncs = new Map<string, unknown>();
      for (const v of list(r.syncs)) syncs.set(u.str(rec(v).peerId), rec(v).sync);
      const now = Date.now();
      const next: PeerView[] = [];
      for (const v of list(r.peers)) {
        const pv = rec(v);
        const id = u.str(pv.id);
        if (id.length === 0) continue;
        const old = peers.find((p) => p.id === id);
        const lastSeenMs = u.num(pv.lastSeenMs, 0);
        const p: PeerView = {
          id,
          name: u.str(pv.name),
          address: u.str(pv.address),
          port: u.num(pv.port, 0),
          lastSeenMs,
          online: now - lastSeenMs < ONLINE_MS,
          repos: old !== undefined ? old.repos : [],
          syncedMs: old !== undefined ? old.syncedMs : 0,
          syncing: old !== undefined ? old.syncing : false,
          syncError: old !== undefined ? old.syncError : "",
        };
        const sync = syncs.get(id);
        if (sync !== undefined) applySync(p, sync);
        next.push(p);
      }
      peers = next;
      return true;
    };

    /** What a fetch brought, told in one line. */
    const fetchedLine = (p: PeerView, key: string): string => {
      const had = p.repos.filter((r) => r.local.length > 0 && (key.length === 0 || r.key === key));
      if (had.length === 0) return "fetched from " + p.name + ": it offers no repository this machine has" + (p.repos.some((r) => isMine(r.repoId)) ? " shared (s shares this folder)" : "");
      if (had.length === 1) return "fetched " + had[0].name + " from " + p.name + (had[0].branch.length > 0 ? " · " + had[0].branch + ": " : ": ") + standing(had[0]);
      return "fetched from " + p.name + ": " + had.map((r) => r.name + " " + (repoTag(r).text.length > 0 ? repoTag(r).text : "fetched")).join(" · ");
    };

    /**
     * The daemon fetches `p`'s copies into this machine's shared checkouts (one, at `key`) and counts
     * the current branch of each against theirs; the view takes the answer. A request made while one
     * is in flight for the same peer runs after it, so it sees what changed meanwhile.
     */
    const inFlight = new Map<string, Promise<void>>();
    const syncPeer = async (p: PeerView, key: string, say: boolean): Promise<void> => {
      for (let running = inFlight.get(p.id); running !== undefined; running = inFlight.get(p.id)) await running;
      const job = runSync(p, key, say);
      inFlight.set(p.id, job);
      try {
        await job;
      } finally {
        if (inFlight.get(p.id) === job) inFlight.delete(p.id);
      }
    };

    const runSync = async (p: PeerView, key: string, say: boolean): Promise<void> => {
      p.syncing = true;
      redraw();
      const a = await req("POST", "/api/peer/sync", { peerId: p.id, key });
      // The state may have been read again meanwhile: the answer lands on the peer's current view.
      const live = peers.find((x) => x.id === p.id) ?? p;
      p.syncing = false;
      live.syncing = false;
      if (a.status !== 200) {
        live.syncError = a.status === 0 ? "the daemon is not running" : u.clip(u.str(rec(rec(parse(a.text)).sync).error) || a.text.split("\n")[0], 80);
        api.note("peers: fetch from " + live.name + " failed: " + live.syncError);
        if (say) api.tell("fetch from " + live.name + " failed: " + live.syncError);
        redraw();
        return;
      }
      applySync(live, rec(parse(a.text)).sync);
      api.note("peers: fetched from " + live.name + ": " + live.repos.filter((r) => r.local.length > 0).map((r) => r.name + " " + repoTag(r).text).join(", "));
      if (say) api.tell(fetchedLine(live, key));
      redraw();
    };

    /**
     * Read everything again: the daemon's state (with each peer's last sync), and (when due) a fetch
     * from each online peer. `start` asks the app to start the daemon when none answers (the user
     * opened the tab or used /peers); a timer's refresh starts one only when the bridge is already
     * in use here.
     */
    const refresh = async (pings: boolean, start: boolean): Promise<void> => {
      if (refreshing) return;
      refreshing = true;
      try {
        if (daemon !== "running") {
          const ok = await api.peers.ensure(start);
          if (!ok) {
            daemon = start ? "could not start" : "not running";
            redraw();
            return;
          }
        }
        if (myRepoId.length === 0) myRepoId = await api.git.rootCommit();
        if (pings) await req("POST", "/api/peers/refresh");
        if (!(await readState())) {
          redraw();
          return;
        }
        redraw();
        for (const p of peers) {
          if (!p.online || p.syncing) continue;
          const due = autoFetch && (p.syncedMs === 0 || Date.now() - p.syncedMs > AUTO_FETCH_MS);
          if (due) await syncPeer(p, "", false);
        }
        redraw();
      } finally {
        refreshing = false;
      }
    };

    /** The daemon answering, started for the user's action when it was not; false (and told) when it could not be. */
    const up = async (): Promise<boolean> => {
      if (daemon === "running") return true;
      const ok = await api.peers.ensure(true);
      if (!ok) {
        daemon = "could not start";
        redraw();
        api.tell("the peers daemon could not start; /log says why");
      }
      return ok;
    };

    const pairStart = async (): Promise<void> => {
      if (!(await up())) return;
      const a = await req("POST", "/api/pair/start");
      if (a.status !== 200) return api.tell("could not start pairing: " + (a.status === 0 ? "the daemon is not running" : a.text));
      const r = rec(parse(a.text));
      const pr = rec(r.pairing);
      pairing = { code: u.str(pr.code), expiresMs: u.num(pr.expiresMs, 0) };
      me.port = u.num(r.port, me.port);
      me.addresses = list(r.addresses).map((x) => u.str(x));
      folded.delete("pairing");
      redraw();
      api.actions.showPanel("peers");
      api.tell("pairing code " + pairing.code + ", two minutes: on the other machine, /peers join " + (me.addresses[0] ?? "<this address>") + ":" + String(me.port) + " " + pairing.code);
    };

    const pairJoin = async (arg: string): Promise<void> => {
      const parts = arg.trim().split(/\s+/);
      if (parts.length < 2 || parts[0].length === 0) return api.tell("/peers join <host[:port]> <code>");
      const hp = hostPort(parts[0]);
      if (!(await up())) return;
      // A name is resolved by the daemon: a paired or nearby machine's.
      const a = await req("POST", "/api/pair/join", { address: hp.address, port: hp.port, code: parts[1] });
      if (a.status !== 200) return api.tell("could not join " + parts[0] + ": " + u.str(rec(parse(a.text)).error));
      const peer = rec(rec(parse(a.text)).peer);
      api.tell("paired with " + u.str(peer.name) + " at " + hp.address + ":" + String(hp.port));
      await refresh(true, true);
    };

    const shareHere = async (): Promise<void> => {
      if (!(await up())) return;
      const r = await api.peers.share();
      if (r.error.length > 0) return api.tell("could not share this folder: " + r.error);
      api.tell("sharing this folder's repository with the paired machines (" + r.key + ")");
      for (const p of peers) p.syncedMs = 0;
      await refresh(false, true);
    };

    /** Share the checkout at `path` (another folder of this machine), live. */
    const sharePath = async (path: string): Promise<void> => {
      if (!(await up())) return;
      const a = await req("POST", "/api/share", { path });
      if (a.status !== 200) return api.tell("could not share " + path + ": " + u.str(rec(parse(a.text)).error));
      const r = rec(rec(parse(a.text)).repo);
      api.tell("sharing " + u.str(r.name) + " with the paired machines (" + u.str(r.key) + ")");
      for (const p of peers) p.syncedMs = 0;
      await refresh(false, true);
    };

    /** Host a bare repository: a new one under the store by name, or an existing bare one by its path. */
    const host = async (arg: string): Promise<void> => {
      const what = arg.trim();
      if (what.length === 0) return api.tell("/peers host <name> makes a bare repository peers may push into; /peers host /path/to/repo.git hosts one that exists");
      if (!(await up())) return;
      const byPath = what.includes("/");
      const a = await req("POST", "/api/host", byPath ? { name: what.replace(/\/+$/, "").split("/").pop() ?? what, path: what } : { name: what, path: "" });
      if (a.status !== 200) return api.tell("could not host " + what + ": " + u.str(rec(parse(a.text)).error));
      const r = rec(rec(parse(a.text)).repo);
      api.tell("hosting " + u.str(r.name) + " at " + u.str(r.key) + ": paired machines may push to http://" + (me.addresses[0] ?? "<this address>") + ":" + String(me.port) + "/" + u.str(r.key));
      await refresh(false, true);
    };

    /** Clone `r` from `p` (to `path`, else beside this folder), shared here once it is. */
    const clone = async (p: PeerView, r: RepoView, path: string): Promise<void> => {
      if (!(await up())) return;
      if (r.local.length > 0) return api.tell(r.name + " is here already: " + r.local);
      api.tell("cloning " + r.name + " from " + p.name + "…");
      const a = await api.peers.clone(p.id, r.key, r.name, path);
      if (a.error.length > 0) return api.tell("could not clone " + r.name + " from " + p.name + ": " + a.error);
      api.tell("cloned " + r.name + " from " + p.name + " to " + a.path + ", shared here as well");
      await refresh(false, true);
    };

    const unshareHere = async (): Promise<void> => {
      const s = myShare();
      if (s === null) return api.tell("this folder's repository is not shared");
      await req("POST", "/api/unshare", { key: s.key });
      api.tell("no longer sharing " + s.name);
      for (const p of peers) p.syncedMs = 0;
      await refresh(false, false);
    };

    const forget = async (p: PeerView): Promise<void> => {
      await req("POST", "/api/forget", { peerId: p.id });
      api.tell("forgot " + p.name + "; its token no longer works here");
      await refresh(false, false);
    };

    /** The peer the cursor is on (its row, a repository of it, or its note), else the first online one. */
    const peerAtCursor = (): PeerView | null => {
      const r = rows[selected];
      if (r !== undefined && (r.kind === "peer" || r.kind === "peer-note" || r.kind === "peer-repo")) return peers[r.peer ?? 0];
      for (const p of peers) if (p.online) return p;
      return peers[0] ?? null;
    };

    const act = (how: string): void => {
      const r = rows[selected];
      if (r === undefined || r.kind === "gap") return;
      if (r.kind === "section") {
        const name = r.section ?? "";
        if (folded.has(name)) folded.delete(name);
        else folded.add(name);
        redraw();
        showDetail();
        return;
      }
      if (how !== "enter") return;
      if (r.kind === "me" && daemon !== "running") {
        void refresh(true, true);
        return;
      }
      if (r.kind === "share") {
        void shareHere();
        return;
      }
      showDetail();
    };

    const move = (step: number): boolean => {
      let next = selected;
      do next = Math.max(0, Math.min(rows.length - 1, next + step));
      while (rows[next] !== undefined && rows[next].kind === "gap" && next > 0 && next < rows.length - 1);
      selected = next;
      panel.refresh();
      panel.reveal(selected);
      showDetail();
      return true;
    };
    api.keys.action({ id: "peers.up", scope: "peers", key: "up", run: () => move(-1) });
    api.keys.action({ id: "peers.down", scope: "peers", key: "down", run: () => move(1) });
    api.keys.action({
      id: "peers.open",
      scope: "peers",
      help: "details, or shares, or folds",
      key: "enter",
      run: () => {
        act("enter");
        return true;
      },
    });
    api.keys.action({
      id: "peers.fetch",
      scope: "peers",
      help: "fetch from the peer (or the one repository) under the cursor",
      key: "char:f",
      run: () => {
        const at = repoAt(rows[selected]);
        if (at !== null) {
          if (at.repo.local.length === 0) api.tell(isMine(at.repo.repoId) ? "share this folder first (s): the daemon then fetches it" : at.repo.mode === "hosted" ? "nothing here to fetch it into" : "nothing here to fetch it into: c clones it");
          else void syncPeer(at.peer, at.repo.key, true);
          return true;
        }
        const p = peerAtCursor();
        if (p === null) api.tell("no peer to fetch from: p pairs one");
        else void syncPeer(p, "", true);
        return true;
      },
    });
    api.keys.action({
      id: "peers.clone",
      scope: "peers",
      help: "clone the repository under the cursor beside this folder",
      key: "char:c",
      run: () => {
        const at = repoAt(rows[selected]);
        if (at === null) api.tell("c clones a peer's repository this machine lacks: put the cursor on one");
        else if (at.repo.mode === "hosted" && at.repo.local.length === 0) api.tell("a hosted repository is pushed into, not cloned here");
        else void clone(at.peer, at.repo, "");
        return true;
      },
    });
    api.keys.action({
      id: "peers.pair",
      scope: "peers",
      help: "show a pairing code",
      key: "char:p",
      run: () => {
        void pairStart();
        return true;
      },
    });
    api.keys.action({
      id: "peers.share",
      scope: "peers",
      help: "share or unshare this folder",
      key: "char:s",
      run: () => {
        if (myShare() === null) void shareHere();
        else void unshareHere();
        return true;
      },
    });
    api.keys.action({
      id: "peers.forget",
      scope: "peers",
      help: "forget the peer under the cursor",
      key: "char:x",
      run: () => {
        const r = rows[selected];
        if (r !== undefined && (r.kind === "peer" || r.kind === "peer-note" || r.kind === "peer-repo")) void forget(peers[r.peer ?? 0]);
        else api.tell("x forgets the peer under the cursor");
        return true;
      },
    });
    api.keys.action({
      id: "peers.refresh",
      scope: "peers",
      help: "read again",
      key: "char:r",
      run: () => {
        void refresh(true, true);
        return true;
      },
    });

    api.commands.add({
      name: "/peers",
      usage: "[pair | join <host[:port]> <code> | share [path] | unshare | host <name|path> | fetch <peer> [repo] | clone <peer> <repo> [path] | forget <peer> | name <name> | stop]",
      help: "the machines on this network sharing repositories with this one",
      run: (arg) => {
        const parts = arg.trim().split(/\s+/);
        const verb = parts[0] ?? "";
        const rest = parts.slice(1).join(" ");
        if (verb.length === 0) return api.actions.showPanel("peers");
        if (verb === "name" || verb === "fetch" || verb === "forget" || verb === "unshare") void up();
        if (verb === "pair") return void pairStart();
        if (verb === "join") return void pairJoin(rest);
        if (verb === "share") return void (rest.length > 0 ? sharePath(rest) : shareHere());
        if (verb === "unshare") return void unshareHere();
        if (verb === "host") return void host(rest);
        if (verb === "fetch" || verb === "forget" || verb === "clone") {
          const p = peerNamed(parts[1] ?? "");
          if (p === null) return api.tell((parts[1] ?? "").length > 0 ? "no peer named " + parts[1] : "/peers " + verb + " <peer>" + (verb === "clone" ? " <repo> [path]" : verb === "fetch" ? " [repo]" : ""));
          if (verb === "forget") return void forget(p);
          const r = parts.length > 2 ? repoNamed(p, parts[2]) : null;
          if (parts.length > 2 && r === null) return api.tell(p.name + " offers no repository named " + parts[2] + (p.repos.length > 0 ? ": " + p.repos.map((x) => x.name).join(", ") : ""));
          if (verb === "fetch") return void syncPeer(p, r !== null ? r.key : "", true);
          if (r === null) return api.tell("/peers clone " + p.name + " <repo> [path]" + (p.repos.length > 0 ? ": " + p.repos.map((x) => x.name).join(", ") : ""));
          return void clone(p, r, parts[3] ?? "");
        }
        if (verb === "name") {
          if (rest.length === 0) return api.tell("/peers name <name>");
          void req("POST", "/api/rename", { name: rest }).then((a) => {
            api.tell(a.status === 200 ? "this machine is now " + rest + " to its peers" : "could not rename: " + a.text);
            void refresh(false, false);
          });
          return;
        }
        if (verb === "stop") {
          void req("POST", "/api/stop").then(() => {
            daemon = "stopped";
            peers = [];
            redraw();
            api.tell("the peers daemon stopped; it starts again when needed");
          });
          return;
        }
        api.tell("/peers " + verb + "? pair, join, share, unshare, host, fetch, clone, forget, name or stop");
      },
      complete: (arg) => ["pair", "join ", "share", "unshare", "host ", "fetch ", "clone ", "forget ", "name ", "stop"].filter((v) => v.startsWith(arg.trim())),
    });

    api.every(refreshMs, () => {
      if (daemon === "stopped") return;
      void refresh(true, false);
    });
    api.every(1000, () => {
      if (pairing !== null && api.state.active().panel === "peers") panel.refresh();
    });
    layout();
    api.after(2000, () => {
      void refresh(true, false);
    });
  },
});

export {};
