// Dirty repo guard: a fork of a session whose folder has uncommitted changes asks to go on, and
// is refused when the answer is no or there is no UI to ask. A clean folder, or one that is not a
// git repository, forks without a question.

const SHOWN_LINES = 20;

/** The first lines of `status`, at most SHOWN_LINES. */
const firstLines = (status: string): string => status.trim().split("\n").slice(0, SHOWN_LINES).join("\n");

widecode.plugin({
  id: "dirty-repo-guard",
  agent(agent) {
    agent.on("session_before_fork", async (_event, ctx) => {
      const result = await agent.exec("git", ["status", "--porcelain"], { timeout: 10000 });
      if (result.code !== 0) return;
      const status = result.stdout.trim();
      if (status.length === 0) return;
      if (!ctx.hasUI) return { cancel: true };
      const yes = await ctx.ui.confirm("Fork with uncommitted changes?", firstLines(result.stdout));
      if (!yes) return { cancel: true };
    });
  },
});

export {};
