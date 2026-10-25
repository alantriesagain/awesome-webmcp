// Peers: the LAN git bridge's tab and segment. The tab is a short list: this machine with what it
// shares (◆ marks this folder's repository), the machines paired with it (● online, ○ not, and how
// the current branch stands against their copy: ↓ what they have that we lack), the machines nearby
// that are not paired yet, and, while a code is shown, the pairing code with its time left. The
// details live in the code column: the row under the cursor opens a page there (this machine's id,
// addresses, shares with their paths and the URLs peers use, the way another machine joins; a
// peer's address, remote, branches against ours and what it offers). Enter opens the page, f
// fetches the peer under the cursor, s shares or unshares this folder, p shows a code, x forgets a
// peer, r reads again. `/peers` opens the tab; `/peers pair`, `/peers join <host[:port]> <code>`,
// `/peers share [path]`, `/peers unshare`, `/peers host <name|path>`, `/peers fetch <peer>`, `/peers forget
// <peer>`, `/peers name <name>` and `/peers stop` do the same from the composer. The daemon
// (widecode --peers-daemon) does the serving and is started when this plugin needs it; auto-fetch
// keeps ahead and behind live. Nothing here touches a working tree: a fetch writes refs only.

type Run = widecode.Run;
type Row = widecode.Row;

const T = widecode.theme;
const u = widecode.util;
const DIM = T.dim;
const SELECTED_BG = T.selected;
const DEFAULT_PORT = 7337;
const DEFAULT_REFRESH_MS = 10000;
const AUTO_FETCH_MS = 120000;
const ONLINE_MS = 180000;

interface RowSpec {
  kind: "section" | "gap" | "me" | "repo" | "share" | "peer" | "peer-note" | "nearby" | "code" | "hint" | "empty";
  section?: string;
  peer?: number;
  repo?: number;
  near?: number;
  text?: string;
}

type RemoteBranch = { name: string; ref: string; sha: string; commitMs: number; local: boolean; ahead: number; behind: number };

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

interface Offered {
  key: string;
  repoId: string;
  name: string;
  mode: string;
  tips: Record<string, string>;
}

interface PeerView {
  id: string;
  name: string;
  address: string;
  port: number;
  lastSeenMs: number;
  online: boolean;
  repos: Offered[];
  /** The remote of this folder's repository that points at this peer's copy ("" until set). */
  remote: string;
  fetching: boolean;
  fetchedMs: number;
  fetchError: string;
  ahead: number;
  behind: number;
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

const offeredOf = (v: unknown): Offered => {
  const r = rec(v);
  const tips: Record<string, string> = {};
  for (const b of list(r.branches)) {
    const br = rec(b);
    if (u.str(br.name).length > 0) tips[u.str(br.name)] = u.str(br.sha);
  }
  return { key: u.str(r.key), repoId: u.str(r.repoId), name: u.str(r.name), mode: u.str(r.mode), tips };
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

widecode.plugin({
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
    let branch = "";
    let rows: RowSpec[] = [];
    let selected = 0;
    let refreshing = false;
    const folded = new Set<string>();

    const req = (method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> => api.peers.request(method, path, body);

    const myShare = (): Shared | null => {
      for (const s of shared) if (s.mode === "live" && s.repoId === myRepoId && myRepoId.length > 0) return s;
      return null;
    };
    /** The peer's copy of this folder's repository: a hosted one first (it takes pushes too), else its live checkout. */
    const match = (p: PeerView): Offered | null => {
      let live: Offered | null = null;
      for (const o of p.repos) {
        if (myRepoId.length === 0 || o.repoId !== myRepoId) continue;
        if (o.mode === "hosted") return o;
        if (live === null) live = o;
      }
      return live;
    };
    const peerNamed = (name: string): PeerView | null => {
      for (const p of peers) if (p.name === name || p.id === name || p.id.startsWith(name)) return p;
      return null;
    };

    /** What a peer's row says on the right: the current branch against its copy, or what is going on. */
    const tagOf = (p: PeerView): { text: string; fg: string } => {
      if (p.fetching) return { text: "…", fg: DIM };
      if (p.fetchError.length > 0) return { text: "!", fg: T.bad };
      if (p.remote.length === 0 || p.ahead < 0) return { text: "", fg: "" };
      if (p.behind > 0) return { text: "↓" + String(p.behind) + (p.ahead > 0 ? " ↑" + String(p.ahead) : ""), fg: T.warn };
      if (p.ahead > 0) return { text: "↑" + String(p.ahead), fg: T.ok };
      return { text: "level", fg: DIM };
    };

    /** A short line under a peer: what is going on, or why there is nothing to fetch; "" for none. */
    const peerNote = (p: PeerView): string => {
      if (p.fetching) return "fetching…";
      if (p.fetchError.length > 0) return p.fetchError;
      if (p.online && p.repos.length > 0 && match(p) === null) return "no copy of this folder";
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

    const sectionTitle = (name: string): string => (name === "me" ? "This machine" : name === "peers" ? "Peers" + (peers.length > 0 ? " · " + String(peers.length) : "") : "Pairing");

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
        const mine = s.repoId === myRepoId && s.mode === "live" && myRepoId.length > 0;
        return pairRow(bg, { text: "   " + (mine ? "◆ " : "• "), fg: mine ? T.link : DIM }, s.name, mine ? T.link : "", mine, s.mode === "hosted" ? "hosted" : "live", DIM, width);
      }
      if (r.kind === "share") return { bg, runs: [{ text: "   ○ ", fg: DIM }, { text: "share this folder", fg: T.link }, { text: "  s", fg: DIM }] };
      if (r.kind === "peer") {
        const p = peers[r.peer ?? 0];
        const tag = tagOf(p);
        return pairRow(bg, { text: "   " + (p.online ? "● " : "○ "), fg: p.online ? T.ok : DIM }, p.name, "", true, tag.text, tag.fg, width);
      }
      if (r.kind === "peer-note") return plain("  " + (r.text ?? ""), peers[r.peer ?? 0].fetchError.length > 0 ? T.bad : DIM);
      if (r.kind === "nearby") return pairRow(bg, { text: "   ○ ", fg: DIM }, nearby[r.near ?? 0].name, "", false, "nearby", DIM, width);
      if (r.kind === "code") {
        const left = pairing !== null ? Math.max(0, Math.round((pairing.expiresMs - now) / 1000)) : 0;
        return { bg, runs: [{ text: "   ", fg: "" }, { text: pairing !== null ? pairing.code : "", fg: T.link, bold: true }, { text: "  " + String(Math.floor(left / 60)) + ":" + String(left % 60).padStart(2, "0"), fg: left < 20 ? T.warn : DIM }] };
      }
      if (r.kind === "hint") return plain("↵ details · f fetch · p pair", DIM);
      return plain(r.text ?? "", DIM);
    };

    const remoteBranches = new Map<string, RemoteBranch[]>();
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
      const joinLine = (): string => "/peers join " + (me.addresses[0] ?? "<this machine's address>") + (me.port > 0 && me.port !== DEFAULT_PORT ? ":" + String(me.port) : "") + " " + (pairing !== null && pairing.expiresMs > Date.now() ? pairing.code : "<code>");
      const r = rows[selected];
      const kind = r === undefined ? "me" : r.kind;
      if (kind === "peer" || kind === "peer-note") {
        const p = peers[r?.peer ?? 0];
        put(p.name, "", true);
        blank();
        field("state", (p.online ? "online" : p.lastSeenMs > 0 ? "not seen for " + u.age(Date.now() - p.lastSeenMs) : "never seen") + (p.fetching ? " · fetching…" : ""), p.online ? T.ok : DIM);
        field("address", p.address.length > 0 ? p.address + ":" + String(p.port) : "unknown");
        field("id", p.id);
        const mine = match(p);
        field("remote", p.remote.length > 0 ? p.remote + " (in this folder's repository)" : mine !== null ? "not set up yet" : p.repos.length === 0 ? "nothing offered yet" : "none: it offers no copy of this folder's repository");
        if (p.fetchedMs > 0) field("fetched", u.age(Date.now() - p.fetchedMs) + " ago" + (p.fetchError.length > 0 ? " · failed: " + p.fetchError : ""), p.fetchError.length > 0 ? T.bad : "");
        const list = remoteBranches.get(p.remote) ?? [];
        if (p.remote.length > 0 && list.length > 0) {
          blank();
          put("Branches, theirs against ours", DIM);
          for (const b of list) {
            const track = b.local ? (b.behind > 0 ? "↓" + String(b.behind) : "") + (b.ahead > 0 ? (b.behind > 0 ? " " : "") + "↑" + String(b.ahead) : "") + (b.ahead === 0 && b.behind === 0 ? "level" : "") : "not here";
            out.push({ runs: [{ text: " " + u.clip(b.name, 24).padEnd(25, " "), fg: b.name === branch ? T.link : "" }, { text: track.padEnd(10, " "), fg: b.behind > 0 ? T.warn : b.local ? T.ok : DIM }, { text: b.sha.slice(0, 7) + "  " + (b.commitMs > 0 ? u.age(Date.now() - b.commitMs) : ""), fg: DIM }] });
          }
        }
        if (p.repos.length > 0) {
          blank();
          put("Offers", DIM);
          for (const o of p.repos) {
            const same = myRepoId.length > 0 && o.repoId === myRepoId;
            out.push({ runs: [{ text: " " + (same ? "◆ " : "• "), fg: same ? T.link : DIM }, { text: u.clip(o.name, 24).padEnd(25, " "), fg: same ? T.link : "" }, { text: o.mode === "hosted" ? "hosted, takes pushes" : same ? "live, this folder's" : "live", fg: DIM }] });
            put("    http://" + p.address + ":" + String(p.port) + "/" + o.key, DIM);
          }
        }
        blank();
        put("› f   fetch from it now", "");
        put("› x   forget it: its token stops opening this machine", "");
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
        field("announced", discovery ? "yes, over mDNS as _widecode._tcp" : "no (discovery off, or no avahi or dns-sd)", discovery ? "" : DIM);
        field("id", me.id);
      }
      blank();
      put("Shared" + (shared.length > 0 ? "" : ": nothing yet"), DIM);
      for (const sh of shared) {
        const mine = sh.repoId === myRepoId && sh.mode === "live" && myRepoId.length > 0;
        out.push({ runs: [{ text: " " + (mine ? "◆ " : "• "), fg: mine ? T.link : DIM }, { text: u.clip(sh.name, 24).padEnd(25, " "), fg: mine ? T.link : "", bold: mine }, { text: sh.mode === "hosted" ? "hosted, takes pushes" : mine ? "live, this folder" : "live", fg: DIM }] });
        put("    " + sh.path, DIM);
        put("    " + (sh.branches !== null ? "branches " + sh.branches.join(", ") : "every branch") + " · " + (sh.allow !== null ? String(sh.allow.length) + " peers allowed" : "every paired peer"), DIM);
        put("    http://" + (me.addresses[0] ?? "<address>") + ":" + String(me.port) + "/" + sh.key, DIM);
      }
      if (myShare() === null && myRepoId.length > 0 && daemon === "running") put("› s   share this folder's repository", "");
      blank();
      put("Pairing", DIM);
      if (pairing !== null && pairing.expiresMs > Date.now()) {
        const left = Math.max(0, Math.round((pairing.expiresMs - Date.now()) / 1000));
        out.push({ runs: [{ text: " code  ", fg: DIM }, { text: pairing.code, fg: T.link, bold: true }, { text: "  " + String(Math.floor(left / 60)) + ":" + String(left % 60).padStart(2, "0") + " left", fg: left < 20 ? T.warn : DIM }] });
        put("on the other machine: " + joinLine(), "");
      } else put("› p   show a code for two minutes; the other machine joins with " + joinLine(), "");
      put("› /peers join <host:port> <code>", "");
      put("      join a machine showing a code; a nearby machine's name works as the host", DIM);
      put("› /peers share <path>", "");
      put("      share another checkout of this machine", DIM);
      put("› /peers host <name>", "");
      put("      a bare repository paired machines push into", DIM);
      blank();
      for (const part of wrap("A machine that cannot be reached while it sees this one has port " + String(me.port > 0 ? me.port : DEFAULT_PORT) + "/tcp closed by its firewall (on Linux with ufw: sudo ufw allow " + String(me.port > 0 ? me.port : DEFAULT_PORT) + "/tcp).", w)) put(part, DIM);
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
        return best !== null && best.behind > 0 ? [{ text: "↓" + String(best.behind), fg: T.warn }] : [];
      },
      info: () => [{ text: " " + (daemon === "running" ? String(peers.filter((p) => p.online).length) + " online · sharing " + String(shared.length) : daemon === "starting" ? "starting the daemon…" : daemon === "not running" ? "idle" : daemon), fg: daemon === "running" ? DIM : T.warn }],
      press: (row) => {
        selected = row;
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

    /** The online peer whose copy of this folder's branch is furthest ahead of ours. */
    const bestPeer = (): PeerView | null => {
      let best: PeerView | null = null;
      for (const p of peers) if (p.remote.length > 0 && p.behind > 0 && (best === null || p.behind > best.behind)) best = p;
      return best;
    };

    api.ui.segment({
      name: "peers",
      draw: () => {
        if (daemon !== "running" || peers.length === 0) return [];
        const best = bestPeer();
        if (best !== null) return [{ text: best.name + " ↓" + String(best.behind), fg: T.warn }];
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
      const now = Date.now();
      const next: PeerView[] = [];
      for (const v of list(r.peers)) {
        const pv = rec(v);
        const id = u.str(pv.id);
        if (id.length === 0) continue;
        const old = peers.find((p) => p.id === id);
        const lastSeenMs = u.num(pv.lastSeenMs, 0);
        next.push({
          id,
          name: u.str(pv.name),
          address: u.str(pv.address),
          port: u.num(pv.port, 0),
          lastSeenMs,
          online: now - lastSeenMs < ONLINE_MS,
          repos: old !== undefined ? old.repos : [],
          remote: old !== undefined ? old.remote : "",
          fetching: old !== undefined ? old.fetching : false,
          fetchedMs: old !== undefined ? old.fetchedMs : 0,
          fetchError: old !== undefined ? old.fetchError : "",
          ahead: old !== undefined ? old.ahead : -1,
          behind: old !== undefined ? old.behind : -1,
        });
      }
      peers = next;
      return true;
    };

    const readOffers = async (p: PeerView): Promise<void> => {
      const a = await req("POST", "/api/peer/repos", { peerId: p.id });
      if (a.status !== 200) return;
      p.repos = list(rec(parse(a.text)).repos).map(offeredOf);
      const mine = match(p);
      if (mine !== null && p.remote.length === 0) p.remote = await api.peers.remote(p.id, mine.key);
    };

    const measure = async (p: PeerView): Promise<void> => {
      if (p.remote.length === 0) return;
      remoteBranches.set(p.remote, await api.git.remoteBranches(p.remote));
      if (branch.length === 0) return;
      const r = await api.git.aheadBehind("HEAD", p.remote + "/" + branch);
      p.ahead = r.ahead;
      p.behind = r.behind;
    };

    const fetchPeer = async (p: PeerView, say: boolean): Promise<void> => {
      if (p.fetching) return;
      if (p.remote.length === 0) {
        await readOffers(p);
        if (p.remote.length === 0) {
          if (say) api.tell(p.name + " offers no copy of this repository");
          return;
        }
      }
      p.fetching = true;
      redraw();
      const r = await api.peers.fetch(p.remote);
      p.fetching = false;
      p.fetchedMs = Date.now();
      p.fetchError = r.code === 0 ? "" : u.clip((r.err.length > 0 ? r.err : "exit " + String(r.code)).split("\n")[0], 60);
      if (r.code === 0) await measure(p);
      api.note("peers: fetch " + p.remote + " -> " + String(r.code) + (r.err.length > 0 ? " " + r.err.split("\n")[0] : ""));
      if (say) api.tell(r.code === 0 ? "fetched " + p.remote + (p.behind > 0 ? ": " + commits(p.behind) + " you do not have on " + branch : p.ahead > 0 ? ": you are " + commits(p.ahead) + " ahead on " + branch : ": nothing new on " + branch) : "fetch from " + p.name + " failed: " + p.fetchError);
      redraw();
    };

    /**
     * Read everything again: the daemon's state, each online peer's offers, and (when due) a fetch of
     * each. `start` asks the app to start the daemon when none answers (the user opened the tab or
     * used /peers); a timer's refresh starts one only when the bridge is already in use here.
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
        branch = api.state.folder().branch;
        if (pings) await req("POST", "/api/peers/refresh");
        if (!(await readState())) {
          redraw();
          return;
        }
        redraw();
        for (const p of peers) {
          if (!p.online) continue;
          if (p.repos.length === 0 || p.remote.length === 0) await readOffers(p);
          const due = autoFetch && p.remote.length > 0 && (p.fetchedMs === 0 || Date.now() - p.fetchedMs > AUTO_FETCH_MS);
          if (due) await fetchPeer(p, false);
          else await measure(p);
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
      await refresh(false, true);
    };

    /** Share the checkout at `path` (another folder of this machine), live. */
    const sharePath = async (path: string): Promise<void> => {
      if (!(await up())) return;
      const a = await req("POST", "/api/share", { path });
      if (a.status !== 200) return api.tell("could not share " + path + ": " + u.str(rec(parse(a.text)).error));
      const r = rec(rec(parse(a.text)).repo);
      api.tell("sharing " + u.str(r.name) + " with the paired machines (" + u.str(r.key) + ")");
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

    const unshareHere = async (): Promise<void> => {
      const s = myShare();
      if (s === null) return api.tell("this folder's repository is not shared");
      await req("POST", "/api/unshare", { key: s.key });
      api.tell("no longer sharing " + s.name);
      await refresh(false, false);
    };

    const forget = async (p: PeerView): Promise<void> => {
      await req("POST", "/api/forget", { peerId: p.id });
      api.tell("forgot " + p.name + "; its token no longer works here");
      await refresh(false, false);
    };

    /** The peer the cursor is on (its row or its note), else the first online one. */
    const peerAtCursor = (): PeerView | null => {
      const r = rows[selected];
      if (r !== undefined && (r.kind === "peer" || r.kind === "peer-note")) return peers[r.peer ?? 0];
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
      help: "fetch from the peer under the cursor",
      key: "char:f",
      run: () => {
        const p = peerAtCursor();
        if (p === null) api.tell("no peer to fetch from: p pairs one");
        else void fetchPeer(p, true);
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
        if (r !== undefined && (r.kind === "peer" || r.kind === "peer-note")) void forget(peers[r.peer ?? 0]);
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
      usage: "[pair | join <host[:port]> <code> | share [path] | unshare | host <name|path> | fetch <peer> | forget <peer> | name <name> | stop]",
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
        if (verb === "fetch" || verb === "forget") {
          const p = peerNamed(rest);
          if (p === null) return api.tell(rest.length > 0 ? "no peer named " + rest : "/peers " + verb + " <peer>");
          return void (verb === "fetch" ? fetchPeer(p, true) : forget(p));
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
        api.tell("/peers " + verb + "? pair, join, share, unshare, host, fetch, forget, name or stop");
      },
      complete: (arg) => ["pair", "join ", "share", "unshare", "host ", "fetch ", "forget ", "name ", "stop"].filter((v) => v.startsWith(arg.trim())),
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
