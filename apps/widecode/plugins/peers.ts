// Peers: the LAN git bridge's tab and segment. The tab shows this machine (its name and id, the
// port it serves on, the repositories it shares), the machines paired with it (online or last
// seen, the repositories they offer matched to this folder's by root commit, the current branch's
// ahead and behind against their copy once fetched) and pairing (the six-digit code shown here, or
// the one to type from the other side); machines announcing themselves on the network that are not
// paired yet are listed as nearby, and a join may name one. Enter fetches the peer under the cursor, s shares or
// unshares this folder's repository, p shows a code, x forgets the peer under the cursor, r reads
// again. `/peers` opens the tab; `/peers pair`, `/peers join <host[:port]> <code>`, `/peers share`,
// `/peers unshare`, `/peers host <name|path>` (a bare repository peers may push into), `/peers fetch
// <peer>`, `/peers forget <peer>`, `/peers name <name>` and
// `/peers stop` do the same from the composer. The daemon (widecode --peers-daemon) does the serving
// and is started when this plugin needs it; auto-fetch keeps ahead and behind live. Nothing here
// touches a working tree: a fetch writes refs only.

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
  kind: "section" | "me" | "serving" | "repo" | "share" | "peer" | "peer-repo" | "nearby" | "pairing" | "hint" | "empty";
  section?: string;
  peer?: number;
  repo?: number;
  near?: number;
  text?: string;
}

interface Shared {
  key: string;
  repoId: string;
  name: string;
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
  return { key: u.str(r.key), repoId: u.str(r.repoId), name: u.str(r.name), mode: u.str(r.mode), branches: strList(r.branches), allow: strList(r.allow) };
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

    const layout = (): void => {
      const out: RowSpec[] = [];
      out.push({ kind: "section", section: "me" });
      if (!folded.has("me")) {
        out.push({ kind: "serving" });
        shared.forEach((_s, i) => out.push({ kind: "repo", repo: i }));
        if (myShare() === null && myRepoId.length > 0) out.push({ kind: "share" });
      }
      out.push({ kind: "section", section: "peers" });
      if (!folded.has("peers")) {
        if (peers.length === 0 && nearby.length === 0) out.push({ kind: "empty", text: discovery ? "no peer paired yet, none announcing itself nearby" : "no peer paired yet" });
        peers.forEach((p, i) => {
          out.push({ kind: "peer", peer: i });
          p.repos.forEach((_o, k) => out.push({ kind: "peer-repo", peer: i, repo: k }));
        });
        nearby.forEach((_n, i) => out.push({ kind: "nearby", near: i }));
      }
      out.push({ kind: "section", section: "pairing" });
      if (!folded.has("pairing")) {
        if (pairing !== null && pairing.expiresMs > Date.now()) out.push({ kind: "pairing" });
        out.push({ kind: "hint", text: pairing !== null && pairing.expiresMs > Date.now() ? "on the other machine: /peers join " + (me.addresses[0] ?? "<this address>") + ":" + String(me.port) + " " + pairing.code : "p shows a code for another machine to join with" });
        out.push({ kind: "hint", text: "/peers join <host:port> <code> joins a machine showing one" + (nearby.length > 0 ? " (a nearby name works: /peers join " + nearby[0].name + " <code>)" : "") });
        out.push({ kind: "hint", text: "a machine that cannot be joined or fetched from has port " + String(me.port > 0 ? me.port : DEFAULT_PORT) + "/tcp closed by its firewall (ufw allow " + String(me.port > 0 ? me.port : DEFAULT_PORT) + "/tcp on Linux)" });
      }
      rows = out;
      if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    };

    const sectionTitle = (name: string): string => {
      if (name === "me") return me.name.length > 0 ? "This machine · " + me.name : "This machine";
      if (name === "peers") return "Peers (" + String(peers.length) + ")";
      return "Pairing";
    };

    const line = (r: RowSpec, index: number, width: number): Row => {
      const bg = index === selected ? SELECTED_BG : "";
      const now = Date.now();
      const text = (s: string, fg: string, bold?: boolean): Row => ({ bg, runs: [{ text: "   " + u.clip(s, Math.max(1, width - 3)), fg, bold }] });
      if (r.kind === "section") {
        const open = !folded.has(r.section ?? "");
        return { bg, runs: [{ text: " " + (open ? "▾ " : "▸ "), fg: DIM }, { text: u.clip(sectionTitle(r.section ?? ""), Math.max(1, width - 3)), fg: "", bold: true }] };
      }
      if (r.kind === "serving") {
        if (daemon !== "running") return text(daemon === "starting" ? "starting the daemon…" : daemon === "not running" ? "the daemon is not running: it starts when this tab is opened or /peers is used" : "daemon " + daemon, T.warn);
        return text("serving on :" + String(me.port) + (me.addresses.length > 0 ? " · " + me.addresses.join(" ") : "") + " · id " + me.id.slice(0, 8) + (discovery ? "" : " · not announced"), DIM);
      }
      if (r.kind === "repo") {
        const s = shared[r.repo ?? 0];
        const mine = s.repoId === myRepoId && s.mode === "live";
        const tail = (s.branches !== null ? " · " + s.branches.join(",") : "") + (s.allow !== null ? " · " + String(s.allow.length) + " allowed" : "") + (mine ? " · this folder" : "") + (s.mode === "hosted" ? " · takes pushes at " + s.key : "");
        return { bg, runs: [{ text: "   ● ", fg: T.ok }, { text: u.clip(s.name, Math.max(4, width - 8 - u.width(tail))), fg: mine ? T.link : "", bold: mine }, { text: " " + s.mode, fg: DIM }, { text: tail, fg: DIM }] };
      }
      if (r.kind === "share") return { bg, runs: [{ text: "   ○ ", fg: DIM }, { text: "share this folder", fg: T.link }, { text: " (s)", fg: DIM }] };
      if (r.kind === "peer") {
        const p = peers[r.peer ?? 0];
        const state = p.fetching ? "fetching…" : p.online ? "online" : p.lastSeenMs > 0 ? "seen " + u.age(now - p.lastSeenMs) + " ago" : "never seen";
        const track = p.remote.length > 0 && p.ahead >= 0 ? (p.behind > 0 ? "↓" + String(p.behind) : "") + (p.ahead > 0 ? (p.behind > 0 ? " " : "") + "↑" + String(p.ahead) : "") : "";
        const tail = (track.length > 0 ? " " + track : "") + (p.fetchedMs > 0 ? " · fetched " + u.age(now - p.fetchedMs) + " ago" : "") + (p.fetchError.length > 0 ? " · " + p.fetchError : "");
        const name = u.clip(p.name, Math.max(4, width - 8 - u.width(state) - u.width(tail)));
        const runs: Run[] = [{ text: "   " + (p.online ? "●" : "○") + " ", fg: p.online ? T.ok : DIM }, { text: name, fg: "", bold: true }, { text: " · " + state, fg: p.online ? T.ok : DIM }];
        if (track.length > 0) runs.push({ text: " " + track, fg: p.behind > 0 ? T.warn : T.ok });
        if (p.fetchedMs > 0) runs.push({ text: " · fetched " + u.age(now - p.fetchedMs) + " ago", fg: DIM });
        if (p.fetchError.length > 0) runs.push({ text: " · " + u.clip(p.fetchError, 40), fg: T.bad });
        return { bg, runs };
      }
      if (r.kind === "peer-repo") {
        const p = peers[r.peer ?? 0];
        const o = p.repos[r.repo ?? 0];
        const same = o.repoId === myRepoId && myRepoId.length > 0;
        const tip = branch.length > 0 && o.tips[branch] !== undefined ? " · " + branch + " " + o.tips[branch].slice(0, 7) : "";
        return { bg, runs: [{ text: "      " + (same ? "● " : "  "), fg: T.link }, { text: u.clip(o.name, Math.max(4, width - 12 - u.width(tip))), fg: same ? T.link : "" }, { text: " " + o.mode + (same ? (o.mode === "hosted" ? " · this folder's, takes pushes" : " · same as this folder") : "") + tip, fg: DIM }] };
      }
      if (r.kind === "nearby") {
        const n = nearby[r.near ?? 0];
        const tail = " · nearby, not paired · " + n.address + ":" + String(n.port);
        return { bg, runs: [{ text: "   ○ ", fg: DIM }, { text: u.clip(n.name, Math.max(4, width - 6 - u.width(tail))), fg: "" }, { text: tail, fg: DIM }] };
      }
      if (r.kind === "pairing") {
        const left = pairing !== null ? Math.max(0, Math.round((pairing.expiresMs - now) / 1000)) : 0;
        return { bg, runs: [{ text: "   code ", fg: DIM }, { text: pairing !== null ? pairing.code : "", fg: T.link, bold: true }, { text: " · " + String(Math.floor(left / 60)) + "m" + String(left % 60).padStart(2, "0") + " left", fg: left < 20 ? T.warn : DIM }] };
      }
      if (r.kind === "hint") return text(r.text ?? "", DIM);
      return text(r.text ?? "", DIM);
    };

    const panel = api.ui.panel({
      id: "peers",
      title: "Peers",
      order: 3,
      width: (cols) => Math.max(34, Math.min(60, Math.floor(cols / 5))),
      count: () => rows.length,
      rows: (from, count, width) => rows.slice(from, from + count).map((r, i) => line(r, from + i, width)),
      badge: () => {
        const best = bestPeer();
        return best !== null && best.behind > 0 ? [{ text: "↓" + String(best.behind), fg: T.warn }] : [];
      },
      info: () => [{ text: " " + (daemon === "running" ? String(peers.filter((p) => p.online).length) + " of " + String(peers.length) + " online · " + String(shared.length) + " shared" : daemon === "starting" ? "starting the daemon…" : "daemon not running"), fg: daemon === "running" ? DIM : T.warn }],
      press: (row, x) => {
        selected = row;
        act("enter", x);
      },
      shown: () => {
        layout();
        panel.refresh();
        void refresh(true, true);
        panel.reveal(selected);
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
      if (p.remote.length === 0 || branch.length === 0) return;
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

    const act = (how: string, _x: number): void => {
      const r = rows[selected];
      if (r === undefined) return;
      if (r.kind === "section") {
        const name = r.section ?? "";
        if (folded.has(name)) folded.delete(name);
        else folded.add(name);
        redraw();
        return;
      }
      if (how !== "enter") return;
      if (r.kind === "share") void shareHere();
      else if (r.kind === "repo" && shared[r.repo ?? 0].repoId === myRepoId) void unshareHere();
      else if (r.kind === "peer" || r.kind === "peer-repo") void fetchPeer(peers[r.peer ?? 0], true);
      else if (r.kind === "pairing" && pairing !== null) api.tell("code " + pairing.code + ": on the other machine, /peers join " + (me.addresses[0] ?? "<this address>") + ":" + String(me.port) + " " + pairing.code);
    };

    const move = (step: number): boolean => {
      selected = Math.max(0, Math.min(rows.length - 1, selected + step));
      panel.refresh();
      panel.reveal(selected);
      return true;
    };
    api.keys.action({ id: "peers.up", scope: "peers", key: "up", run: () => move(-1) });
    api.keys.action({ id: "peers.down", scope: "peers", key: "down", run: () => move(1) });
    api.keys.action({
      id: "peers.open",
      scope: "peers",
      help: "fetches, shares or folds",
      key: "enter",
      run: () => {
        act("enter", -1);
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
        if (r !== undefined && (r.kind === "peer" || r.kind === "peer-repo")) void forget(peers[r.peer ?? 0]);
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
      usage: "[pair | join <host[:port]> <code> | share | unshare | host <name|path> | fetch <peer> | forget <peer> | name <name> | stop]",
      help: "the machines on this network sharing repositories with this one",
      run: (arg) => {
        const parts = arg.trim().split(/\s+/);
        const verb = parts[0] ?? "";
        const rest = parts.slice(1).join(" ");
        if (verb.length === 0) return api.actions.showPanel("peers");
        if (verb === "name" || verb === "fetch" || verb === "forget" || verb === "unshare") void up();
        if (verb === "pair") return void pairStart();
        if (verb === "join") return void pairJoin(rest);
        if (verb === "share") return void shareHere();
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
