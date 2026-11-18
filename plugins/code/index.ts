// The code column: the file chosen anywhere (the tree, the changes, a commit) with its changes
// against the compare base in place, drawn by the core's code widget. It follows the file Claude
// edits (f stops and resumes that), reloads the file when the folder or the base changes under it,
// and moves between changes (n, p), wraps long lines (w or the footer's box, kept between runs) and
// leaves a commit's file or a subagent's steps for the work tree (Esc). The session's record keeps
// the file shown, and resuming the session opens it again. Other plugins open files through api.code.

widecode.plugin({
  id: "code",
  activate(api) {
    const code = api.code;
    api.widgets.code({ title: "Code", order: 2, onWrap: (wrap) => api.settings.setState({ wrap }) });
    const kept = api.settings.state() as { wrap?: unknown } | null;
    if (kept !== null && kept.wrap === true) code.setWrap(true);
    /** Open the file Claude edits as it edits it. */
    let following = true;
    let followedSeq = api.agent.edits().seq;
    /** The session the shown file is kept for, and what was kept ("<id> <path>"), so a record is written once per change. */
    let session = api.agent.sessionId();
    let keptFile = "";

    /** Keep the work tree's file shown in the session's record. */
    const keep = (): void => {
      const id = api.agent.sessionId();
      const path = code.path();
      if (id.length === 0 || path.length === 0 || code.inCommit() || code.inAgent() || keptFile === id + " " + path) return;
      if (api.store.updateSession(id, { file: path })) keptFile = id + " " + path;
    };

    /** Another session: a resumed one opens the file it showed (if it is still there); a new one keeps the file shown now. */
    const sessionChanged = (id: string): void => {
      if (id.length === 0) return;
      const meta = api.store.session(id);
      const file = meta !== null ? meta.file : "";
      if (file.length > 0 && file !== code.path() && api.state.paths().includes(file)) {
        keptFile = id + " " + file;
        code.open(file);
      } else keep();
    };

    /** The open file again, unless a commit's file is shown. */
    const reload = (): void => {
      const open = code.path();
      if (open.length > 0 && !code.inCommit() && !code.inAgent()) code.open(open);
    };

    api.on("conversationChanged", () => {
      const id = api.agent.sessionId();
      if (id !== session) {
        session = id;
        sessionChanged(id);
      }
      // Claude edited a file: show it, unless following is off or a commit is being read.
      const e = api.agent.edits();
      if (e.seq === followedSeq) return;
      followedSeq = e.seq;
      if (!following || e.last.length === 0 || code.inCommit() || code.inAgent()) return;
      api.note("follow " + e.last);
      // The watcher's batch may not have listed a new file yet: list it first so the tree shows it.
      void api.actions
        .loadFiles()
        .then(() => api.actions.loadStatus())
        .then(() => code.open(e.last));
    });
    api.on("folderChanged", () => {
      const b = api.state.batch();
      if (b.git || b.paths.includes(code.path())) reload();
    });
    api.on("baseChanged", reload);
    api.on("fileShown", keep);

    const bind = (id: string, key: string, help: string, run: (count: number) => boolean | void): void => api.keys.action({ id, scope: "code", help, key, run: (_key, count) => run(count) !== false });
    bind("code.up", "up", "", (count) => code.scroll(-count));
    bind("code.down", "down", "", (count) => code.scroll(count));
    bind("code.top", "home", "", () => code.toTop());
    bind("code.end", "end", "", () => code.toEnd());
    bind("code.nextChange", "char:n", "changes", (count) => code.moveHunk(count));
    bind("code.previousChange", "char:p", "changes", (count) => code.moveHunk(-count));
    bind("code.wrap", "char:w", "wrap", () => code.setWrap(!code.wrap()));
    bind("code.follow", "char:f", "follow", () => {
      following = !following;
      api.tell(following ? "following Claude's edits" : "not following Claude's edits");
    });
    bind("code.back", "escape", "", () => {
      if (code.closeTab()) return true;
      if (!code.inCommit() && !code.inAgent()) return false;
      code.open(code.path());
    });
  },
});

export {};
