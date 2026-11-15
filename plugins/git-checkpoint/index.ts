// Git checkpoints: at the start of each turn in a repository the working tree's changes are kept
// as a commit (`git stash create`, which touches neither the tree, the index nor the stash list;
// HEAD when the tree is clean) and recorded as a custom entry of the session (`git-checkpoint`,
// `{ n, commit, at }`). No ref points at it, so the repository gains nothing to clean up and git
// prunes an old checkpoint with its other unreachable objects (after two weeks by default).
// `/checkpoints` lists them, `/checkpoint restore <n>` asks and then restores the tracked files to
// one, leaving untracked files alone, and `/checkpoint clear` forgets the session's list. A
// session loaded again reads the list from its branch.

interface Checkpoint {
  n: number;
  commit: string;
  at: number;
}

interface Restored {
  checkpoints: Checkpoint[];
  next: number;
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The checkpoints a branch's custom entries recorded, and the next number after them. */
const restoredOf = (branch: unknown[]): Restored => {
  const checkpoints: Checkpoint[] = [];
  let next = 1;
  for (const value of branch) {
    const entry = recordOf(value);
    if (entry === null || entry["type"] !== "custom" || entry["customType"] !== "git-checkpoint") continue;
    const data = recordOf(entry["data"]);
    if (data === null) continue;
    if (data["clear"] === true) {
      checkpoints.length = 0;
      next = 1;
      continue;
    }
    const n = numberOf(data["n"]);
    if (n <= 0) continue;
    checkpoints.push({ n: n, commit: stringOf(data["commit"]), at: numberOf(data["at"]) });
    if (n >= next) next = n + 1;
  }
  return { checkpoints: checkpoints, next: next };
};

widecode.plugin({
  id: "git-checkpoint",
  agent(agent) {
    let checkpoints: Checkpoint[] = [];
    let nextN = 1;

    agent.on("session_start", (_event, ctx) => {
      const restored = restoredOf(ctx.sessionManager.getBranch());
      checkpoints = restored.checkpoints;
      nextN = restored.next;
    });

    agent.on("agent_start", async () => {
      const inside = await agent.exec("git", ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
      if (inside.code !== 0 || inside.stdout.trim() !== "true") return;
      const stash = await agent.exec("git", ["stash", "create"], { timeout: 10000 });
      let commit = stash.code === 0 ? stash.stdout.trim() : "";
      if (commit.length === 0) {
        const head = await agent.exec("git", ["rev-parse", "HEAD"], { timeout: 10000 });
        if (head.code !== 0) return;
        commit = head.stdout.trim();
      }
      if (commit.length === 0) return;
      const n = nextN;
      nextN = n + 1;
      const at = Date.now();
      checkpoints.push({ n: n, commit: commit, at: at });
      agent.appendEntry("git-checkpoint", { n: n, commit: commit, at: at });
    });

    agent.registerCommand("checkpoints", {
      description: "List this session's git checkpoints",
      handler(_args, ctx) {
        if (checkpoints.length === 0) {
          ctx.ui.notify("No checkpoints.");
          return;
        }
        const lines: string[] = [];
        for (const c of checkpoints) lines.push(String(c.n) + "  " + widecode.util.age(Date.now() - c.at) + " ago  " + c.commit.slice(0, 7));
        ctx.ui.notify(lines.join("\n"));
      },
    });

    agent.registerCommand("checkpoint", {
      description: "Restore one of this session's git checkpoints, or forget them",
      async handler(args, ctx) {
        const parts = args.trim().split(/\s+/);
        const what = parts[0];
        if (what === "clear") {
          const count = checkpoints.length;
          checkpoints = [];
          nextN = 1;
          agent.appendEntry("git-checkpoint", { clear: true });
          ctx.ui.notify("Forgot " + String(count) + " checkpoint" + (count === 1 ? "" : "s") + ".");
          return;
        }
        if (what === "restore") {
          const n = Number(parts[1]);
          let found: Checkpoint | null = null;
          for (const c of checkpoints) if (c.n === n) found = c;
          if (found === null) {
            ctx.ui.notify("No checkpoint " + (parts[1] ?? "") + ".");
            return;
          }
          if (!ctx.hasUI) {
            ctx.ui.notify("No UI to confirm the restore.");
            return;
          }
          const yes = await ctx.ui.confirm("Restore checkpoint " + String(n) + "?", "The tracked files go back to " + found.commit.slice(0, 7) + ". Untracked files stay.");
          if (!yes) {
            ctx.ui.notify("Restore cancelled.");
            return;
          }
          const present = await agent.exec("git", ["cat-file", "-e", found.commit + "^{commit}"], { timeout: 10000 });
          if (present.code !== 0) {
            ctx.ui.notify("Checkpoint " + String(n) + " is gone: git pruned its commit.");
            return;
          }
          const result = await agent.exec("git", ["restore", "--source", found.commit, "--worktree", "--", "."], { timeout: 30000 });
          if (result.code !== 0) {
            ctx.ui.notify("Restore failed: " + result.stderr.trim());
            return;
          }
          ctx.ui.notify("Restored checkpoint " + String(n) + ".");
          return;
        }
        ctx.ui.notify("Use /checkpoints, /checkpoint restore <n>, or /checkpoint clear.");
      },
    });
  },
});

export {};
