// Git, read-only: the Git tab and the compare base. The tab lists what the changes are compared
// with (HEAD; where this branch left the main one; where this session started; what a peer has on
// this branch), the local branches
// (● the current one, ahead and behind their upstream, the last commit's age; the first 8, then a
// row for the rest), and the log of the branch chosen, this session's commits marked ●. A commit
// opens to its files with their lines; a file shows that commit's change in the code column. The
// peers paired through the peers plugin that have a remote here are listed with their branches, each
// against the local branch of its name (↓ what they have that we do not), and Enter shows one's log;
// the badge says how far the peer furthest ahead is. ↑↓ moves, Enter or → opens, ← closes, b moves
// to the next base. The tab reads git again when the watcher sees the repository
// change. Nothing here checks out, stages or commits: a fetch is the peers plugin's.

type Run = widecode.Run;

interface Row {
  kind: "compare" | "note" | "empty" | "section" | "more" | "branch" | "peer" | "rbranch" | "commit" | "file";
  section?: string;
  index?: number;
  file?: number;
  /** A peer's index (peer and rbranch rows) and a branch's within it (rbranch). */
  peer?: number;
  rbranch?: number;
  text?: string;
}

type PeerRemote = { id: string; name: string; remote: string; online: boolean; lastSeenMs: number };
type RemoteBranch = { name: string; ref: string; sha: string; commitMs: number; local: boolean; ahead: number; behind: number };

const T = widecode.theme;
const BASES = ["head", "branch", "session", "peer"];
const BASE_NAMES = ["HEAD", "branch", "session", "peer"];
const COMPARE = " vs ";
/** Branches listed before a "+N more" row (the current one and the most recently committed). */
const BRANCHES_SHOWN = 8;
const LOG_MAX = 200;
const DIM = T.dim;
const SESSION = T.think;
const SELECTED_BG = T.selected;
const MARK_COLORS = T.marks;

widecode.plugin({
  id: "git",
  activate(api) {
    const u = widecode.util;
    let base = "head";
    let baseNote = "";
    let branches: widecode.Branch[] = [];
    let commits: Required<widecode.Commit>[] = [];
    let logRef = "";
    let sessionBase = "";
    const files = new Map<string, widecode.CommitFile[]>();
    const expanded = new Set<string>();
    const folded = new Set<string>();
    let allBranches = false;
    /** The commit file in the code column ("<sha> <path>"). */
    let shown = "";
    let status = "reading…";
    let rows: Row[] = [];
    let selected = 0;
    let ours = new Set<string>();
    let busy = false;
    let again = false;
    /** The info row: the branch, ahead and behind its upstream ("" before the first read). */
    let info = "";
    /** Ahead and behind the upstream, for the tab's link ("" until read, or level). */
    let track = "";
    /** The paired peers with a remote here, and each remote's branches as fetched. */
    let peers: PeerRemote[] = [];
    const peerBranches = new Map<string, RemoteBranch[]>();
    /** The peer furthest ahead of the current branch, and by how much (0 when none). */
    let peerAhead = 0;
    let peerAheadName = "";
    /** The remote branch refs the log may show (a peer's), beside the local branches. */
    const peerRefs = new Set<string>();

    const layout = (): void => {
      const out: Row[] = [{ kind: "compare" }];
      if (base !== "head" && baseNote.length > 0) out.push({ kind: "note", text: baseNote });
      if (status.length > 0) out.push({ kind: "empty", text: status });
      else {
        out.push({ kind: "section", section: "branches" });
        if (!folded.has("branches")) {
          const n = allBranches ? branches.length : Math.min(branches.length, BRANCHES_SHOWN);
          for (let i = 0; i < n; i++) out.push({ kind: "branch", index: i });
          if (branches.length > BRANCHES_SHOWN) out.push({ kind: "more", text: allBranches ? "fewer branches" : "+" + String(branches.length - BRANCHES_SHOWN) + " more branches" });
        }
        if (peers.length > 0) {
          out.push({ kind: "section", section: "peers" });
          if (!folded.has("peers"))
            peers.forEach((p, i) => {
              out.push({ kind: "peer", peer: i });
              (peerBranches.get(p.remote) ?? []).forEach((_b, k) => out.push({ kind: "rbranch", peer: i, rbranch: k }));
            });
        }
        out.push({ kind: "section", section: "commits" });
        ours = new Set<string>();
        if (sessionBase.length > 0 && commits.some((c) => c.sha === sessionBase))
          for (const c of commits) {
            if (c.sha === sessionBase) break;
            ours.add(c.sha);
          }
        if (!folded.has("commits")) {
          if (commits.length === 0) out.push({ kind: "empty", text: "no commits" });
          commits.forEach((c, i) => {
            out.push({ kind: "commit", index: i });
            if (!expanded.has(c.sha)) return;
            const list = files.get(c.sha);
            if (list === undefined) out.push({ kind: "empty", text: "reading…" });
            else list.forEach((_f, k) => out.push({ kind: "file", index: i, file: k }));
          });
        }
      }
      rows = out;
      if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
      panel.refresh();
    };

    const line = (r: Row, index: number, width: number): widecode.Row => {
      const bg = index === selected && r.kind !== "compare" ? SELECTED_BG : "";
      const now = Date.now();
      if (r.kind === "compare") {
        const runs: Run[] = [{ text: COMPARE, fg: DIM }];
        const kinds = visibleBases();
        kinds.forEach((b, i) => {
          const on = b === base;
          runs.push({ text: " " + BASE_NAMES[BASES.indexOf(b)] + " ", fg: on ? T.link : DIM, bold: on, bg: on ? SELECTED_BG : "" });
          if (i < kinds.length - 1) runs.push({ text: "│", fg: DIM });
        });
        return { runs };
      }
      if (r.kind === "note" || r.kind === "empty" || r.kind === "more") return { bg, runs: [{ text: "   " + u.clip(r.text ?? "", Math.max(1, width - 3)), fg: r.kind === "note" ? T.warn : r.kind === "more" ? T.link : DIM }] };
      if (r.kind === "section") {
        const open = !folded.has(r.section ?? "");
        const title = r.section === "branches" ? "Branches (" + String(branches.length) + ")" : r.section === "peers" ? "Peers (" + String(peers.length) + ")" : "Commits · " + logRef;
        return { bg, runs: [{ text: " " + (open ? "▾ " : "▸ "), fg: DIM }, { text: u.clip(title, Math.max(1, width - 3)), fg: "", bold: true }] };
      }
      if (r.kind === "branch") {
        const b = branches[r.index ?? 0];
        const track = (b.ahead > 0 ? "↑" + String(b.ahead) : "") + (b.behind > 0 ? (b.ahead > 0 ? " " : "") + "↓" + String(b.behind) : "") + (b.gone ? "gone" : "");
        const ago = b.commitMs > 0 ? u.age(now - b.commitMs) : "";
        const tail = (track.length > 0 ? " " + track : "") + " " + ago;
        const name = u.clip(b.name, Math.max(4, width - 6 - tail.length));
        const runs: Run[] = [{ text: "   " + (b.current ? "●" : " ") + " ", fg: T.ok }, { text: name, fg: b.name === logRef ? T.link : "", bold: b.name === logRef }];
        const pad = width - 5 - u.width(name) - tail.length;
        if (pad > 0) runs.push({ text: " ".repeat(pad), fg: "" });
        if (track.length > 0) runs.push({ text: " " + track, fg: b.behind > 0 ? T.warn : T.ok });
        runs.push({ text: " " + ago, fg: DIM });
        return { bg, runs };
      }
      if (r.kind === "peer") {
        const p = peers[r.peer ?? 0];
        const state = p.online ? "online" : p.lastSeenMs > 0 ? "seen " + u.age(now - p.lastSeenMs) + " ago" : "not seen";
        return { bg, runs: [{ text: "   " + (p.online ? "●" : "○") + " ", fg: p.online ? T.ok : DIM }, { text: u.clip(p.name, Math.max(4, width - 8 - state.length)), fg: "", bold: true }, { text: " · " + state, fg: p.online ? T.ok : DIM }] };
      }
      if (r.kind === "rbranch") {
        const p = peers[r.peer ?? 0];
        const b = (peerBranches.get(p.remote) ?? [])[r.rbranch ?? 0];
        const track = b.local ? (b.behind > 0 ? "↓" + String(b.behind) : "") + (b.ahead > 0 ? (b.behind > 0 ? " " : "") + "↑" + String(b.ahead) : "") + (b.ahead === 0 && b.behind === 0 ? "level" : "") : "not here";
        const ago = b.commitMs > 0 ? u.age(now - b.commitMs) : "";
        const tail = " " + track + " " + ago;
        const name = u.clip(b.name, Math.max(4, width - 6 - tail.length));
        const runs: Run[] = [{ text: "     ", fg: "" }, { text: name, fg: b.ref === logRef ? T.link : "", bold: b.ref === logRef }];
        const pad = width - 5 - u.width(name) - tail.length;
        if (pad > 0) runs.push({ text: " ".repeat(pad), fg: "" });
        runs.push({ text: " " + track, fg: b.behind > 0 ? T.warn : b.local ? T.ok : DIM });
        runs.push({ text: " " + ago, fg: DIM });
        return { bg, runs };
      }
      if (r.kind === "commit") {
        const c = commits[r.index ?? 0];
        const ago = " " + u.age(now - c.timeMs);
        const room = Math.max(4, width - 3 - c.short.length - 1 - ago.length);
        const subject = u.clip(c.subject, room);
        const runs: Run[] = [{ text: " " + (expanded.has(c.sha) ? "▾" : "▸"), fg: DIM }, { text: ours.has(c.sha) ? "●" : " ", fg: SESSION }, { text: c.short + " ", fg: T.warn }, { text: subject, fg: "" }];
        const pad = room - u.width(subject);
        if (pad > 0) runs.push({ text: " ".repeat(pad), fg: "" });
        runs.push({ text: ago, fg: DIM });
        return { bg, runs };
      }
      const commit = commits[r.index ?? 0];
      const f = (files.get(commit.sha) ?? [])[r.file ?? 0];
      const color = MARK_COLORS[f.mark] ?? "";
      const counts = f.binary ? " bin" : (f.added > 0 ? " +" + String(f.added) : "") + (f.removed > 0 ? " −" + String(f.removed) : "");
      const runs: Run[] = [{ text: "     " + f.mark + " ", fg: color, bold: true }, { text: u.clip(f.path, Math.max(4, width - 7 - counts.length)), fg: color, dim: f.mark === "D" }];
      if (f.added > 0 || f.binary) runs.push({ text: f.binary ? " bin" : " +" + String(f.added), fg: f.binary ? DIM : T.ok });
      if (f.removed > 0) runs.push({ text: " −" + String(f.removed), fg: T.bad });
      return { bg: shown === commit.sha + " " + f.path ? T.shown : bg, runs };
    };

    /** The commit this session started on: its record's, the one seen at its first message, else HEAD's history at its first record's time (then kept). "" when none is known. */
    const findSessionBase = async (): Promise<string> => {
      const id = api.agent.sessionId();
      const meta = id.length > 0 ? api.store.session(id) : null;
      if (meta !== null && meta.baseCommit.length > 0) return meta.baseCommit;
      const head = api.agent.headAtStart();
      if (head.length > 0) return head;
      const started = api.agent.startMs();
      if (started <= 0) return "";
      const sha = await api.git.commitAt(started);
      if (sha.length > 0 && id.length > 0) api.store.updateSession(id, { baseCommit: sha });
      return sha;
    };

    /** The branches and log again (one read at a time; a request meanwhile reads once more after). */
    const refresh = async (): Promise<void> => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          if (!api.state.folder().repo) {
            status = "not a git repository";
            break;
          }
          branches = await api.git.branches();
          const current = branches.find((b) => b.current);
          peers = await api.peers.remotes();
          peerBranches.clear();
          peerRefs.clear();
          peerAhead = 0;
          peerAheadName = "";
          for (const p of peers) {
            const list = await api.git.remoteBranches(p.remote);
            peerBranches.set(p.remote, list);
            for (const b of list) {
              peerRefs.add(b.ref);
              if (current !== undefined && b.name === current.name && b.behind > peerAhead) {
                peerAhead = b.behind;
                peerAheadName = p.name;
              }
            }
          }
          if (!branches.some((b) => b.name === logRef) && !peerRefs.has(logRef)) logRef = current !== undefined ? current.name : "HEAD";
          commits = await api.git.log(logRef, LOG_MAX);
          sessionBase = await findSessionBase();
          status = "";
          track = current !== undefined ? ((current.ahead > 0 ? "↑" + String(current.ahead) : "") + (current.behind > 0 ? "↓" + String(current.behind) : "")) : "";
          info = (current !== undefined ? "⎇ " + current.name + (current.ahead > 0 ? " ↑" + String(current.ahead) : "") + (current.behind > 0 ? " ↓" + String(current.behind) : "") + (current.upstream.length > 0 ? " " + current.upstream : "") : "detached HEAD") + " · b compare" + (peerAhead > 0 ? " · " + peerAheadName + " ↓" + String(peerAhead) : "");
        } while (again);
      } finally {
        busy = false;
      }
      layout();
    };

    /** The peer furthest ahead on the current branch, with that branch as fetched here; null when none has it. */
    const peerTip = (): { peer: PeerRemote; branch: RemoteBranch } | null => {
      const current = branches.find((b) => b.current);
      if (current === undefined) return null;
      let best: { peer: PeerRemote; branch: RemoteBranch } | null = null;
      for (const p of peers) for (const b of peerBranches.get(p.remote) ?? []) if (b.name === current.name && (best === null || b.behind > best.branch.behind)) best = { peer: p, branch: b };
      return best;
    };

    /**
     * Compare changes with HEAD, where the branch left the main one, where this session started, or
     * what a peer has on this branch. Answers whether the base applied (`quiet` keeps a refusal silent).
     */
    const setBase = async (kind: string, quiet: boolean): Promise<boolean> => {
      let ref = "HEAD";
      let name = "HEAD";
      let note = "";
      const refuse = (why: string): boolean => {
        if (!quiet) api.tell(why);
        return false;
      };
      if (kind === "branch") {
        const main = await api.git.defaultBranch();
        const at = main.length > 0 ? await api.git.mergeBase(main) : "";
        if (at.length === 0) return refuse(main.length === 0 ? "no main branch to compare with (origin's HEAD, main or master)" : "this branch shares no commit with " + main);
        if (at === (await api.git.head())) return refuse("this is " + main + " (or level with it): comparing with the branch is comparing with HEAD");
        ref = at;
        name = main;
        note = "where this branch left " + main + " · " + at.slice(0, 7);
      } else if (kind === "session") {
        const at = await findSessionBase();
        if (at.length === 0) return refuse("this session's start is not known yet: it is recorded with its first message");
        ref = at;
        name = "session start";
        note = "since this session started · " + at.slice(0, 7);
      } else if (kind === "peer") {
        const tip = peerTip();
        if (tip === null) return refuse(peers.length === 0 ? "no peer has a remote here (the Peers tab pairs one)" : "no peer has this branch fetched here");
        ref = tip.branch.sha;
        name = tip.branch.ref;
        note = "what " + tip.peer.name + " has on " + tip.branch.name + " · " + tip.branch.sha.slice(0, 7);
      }
      base = kind;
      baseNote = note;
      layout();
      api.tell("comparing with " + (kind === "head" ? "HEAD" : note));
      api.actions.setBase(ref, kind, name);
      return true;
    };

    /** The bases on offer: the peer one only while a peer has a remote here. */
    const visibleBases = (): string[] => (peers.length > 0 ? BASES : BASES.filter((k) => k !== "peer"));

    /** The next base after the current one (b); one that cannot apply says why and the base stays. */
    const cycleBase = (): void => {
      const kinds = visibleBases();
      const at = kinds.indexOf(base);
      void setBase(kinds[(at + 1) % kinds.length], false);
    };

    /** The selected row acted on: `how` is "enter", "right" (open) or "left" (close); `x` where a press was (-1 for a key). */
    const act = (x: number, how: string): void => {
      const r = rows[selected];
      if (r === undefined) return;
      if (r.kind === "compare") {
        if (x < 0) cycleBase();
        else {
          let pick = "";
          let at = COMPARE.length;
          for (const b of visibleBases()) {
            const w = BASE_NAMES[BASES.indexOf(b)].length + 2;
            if (x >= at && x < at + w) pick = b;
            at += w + 1;
          }
          if (pick.length > 0) void setBase(pick, false);
        }
      } else if (r.kind === "section") {
        const open = !folded.has(r.section ?? "");
        if (how === "enter" || (how === "left") === open) {
          if (open) folded.add(r.section ?? "");
          else folded.delete(r.section ?? "");
        }
      } else if (r.kind === "more") {
        if (how !== "left") allBranches = !allBranches;
      } else if (r.kind === "branch") {
        if (how !== "left") {
          logRef = branches[r.index ?? 0].name;
          void refresh();
        }
      } else if (r.kind === "rbranch") {
        if (how !== "left") {
          const b = (peerBranches.get(peers[r.peer ?? 0].remote) ?? [])[r.rbranch ?? 0];
          if (b !== undefined) {
            logRef = b.ref;
            void refresh();
          }
        }
      } else if (r.kind === "peer") {
        if (how !== "left") api.actions.showPanel("peers");
      } else if (r.kind === "commit") {
        const c = commits[r.index ?? 0];
        const open = expanded.has(c.sha);
        if (how === "enter" || (how === "left") === open) {
          if (open) expanded.delete(c.sha);
          else {
            expanded.add(c.sha);
            if (!files.has(c.sha))
              void api.git.commitFiles(c).then((list) => {
                if (files.size >= 32) for (const old of files.keys()) { files.delete(old); break; }
                files.set(c.sha, list);
                layout();
              });
          }
        }
      } else if (r.kind === "file") {
        const c = commits[r.index ?? 0];
        if (how === "left") {
          for (let i = selected; i >= 0; i--)
            if (rows[i].kind === "commit") {
              selected = i;
              break;
            }
        } else {
          const f = (files.get(c.sha) ?? [])[r.file ?? 0];
          if (f !== undefined) {
            shown = c.sha + " " + f.path;
            api.code.openCommit(c, f.path, f.mark);
          }
        }
      }
      layout();
      panel.reveal(selected);
    };

    const panel = api.ui.panel({
      id: "git",
      title: "Git",
      order: 2,
      width: (cols) => Math.max(34, Math.min(60, Math.floor(cols / 5))),
      count: () => rows.length,
      rows: (from, count, width) => rows.slice(from, from + count).map((r, i) => line(r, from + i, width)),
      badge: () => {
        const out: Run[] = [];
        if (track.length > 0) out.push({ text: track, fg: T.warn });
        if (peerAhead > 0) out.push({ text: (out.length > 0 ? " " : "") + "↓" + String(peerAhead), fg: T.warn });
        return out;
      },
      info: () => [{ text: " " + info, fg: DIM }],
      press: (row, x) => {
        selected = row;
        act(x, "enter");
      },
      shown: () => {
        layout();
        void refresh();
        panel.reveal(selected);
      },
    });
    layout();
    const move = (step: number): boolean => {
      selected = Math.max(0, Math.min(rows.length - 1, selected + step));
      panel.refresh();
      panel.reveal(selected);
      return true;
    };
    const on = (how: string): boolean => {
      act(-1, how);
      return true;
    };
    api.keys.action({ id: "git.up", scope: "git", help: "opens", key: "up", run: () => move(-1) });
    api.keys.action({ id: "git.down", scope: "git", help: "opens", key: "down", run: () => move(1) });
    api.keys.action({ id: "git.open", scope: "git", help: "opens", key: "enter", run: () => on("enter") });
    api.keys.action({ id: "git.expand", scope: "git", key: "right", run: () => on("right") });
    api.keys.action({ id: "git.collapse", scope: "git", key: "left", run: () => on("left") });
    api.keys.action({
      id: "git.compare",
      scope: "git",
      help: "compare",
      key: "char:b",
      run: () => {
        cycleBase();
        return true;
      },
    });
    api.on("folderChanged", () => {
      if (api.state.batch().git && api.state.active().panel === "git") void refresh();
    });
    api.on("fileShown", () => {
      if (!api.code.inCommit() && shown.length > 0) {
        shown = "";
        panel.refresh();
      }
    });
    api.on("messageSending", () => {
      // A new session's first message: the commit it starts on, for "compare with session start".
      if (!api.agent.started() && api.agent.sessionId() === "" && api.agent.headAtStart() === "")
        void api.git.head().then((sha) => {
          if (api.agent.headAtStart() === "") api.agent.setHeadAtStart(sha);
        });
    });
  },
});

export {};
