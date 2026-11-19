// The chat: the conversation with the agent in the first column, the composer under it, drawn by
// the core's chat widget (with the agent's questions, plans and permissions, and the @ completion
// strip). A line from the composer runs the command it starts with, else goes to the agent (with
// images attached by path). It owns the commands about the session as a whole (/new, /compact,
// /quit, /exit, /plan, /mode, /open, and /btw, a side question the agent answers apart from the
// conversation, while it works too), Shift+Tab to cycle the approval mode (ask, auto, plan, full;
// /plan goes to plan and back) and Ctrl+Home / Ctrl+End (the conversation's start, loading what came earlier,
// and its end). The modes are the agent's (api.agent.choices()); the model and effort are the
// models plugin's. Other plugins reach it through api.chat.

widecode.plugin({
  id: "chat",
  activate(api) {
    const send = (text: string): void => {
      if (text.startsWith("/") && api.commands.run(text)) return;
      const r = api.agent.send(text);
      if (r.error.length > 0) api.tell(r.error);
      else if (r.images > 0) api.tell(String(r.images) + (r.images === 1 ? " image attached" : " images attached"));
    };
    api.widgets.chat({ title: "Chat", order: 0, width: (cols) => Math.max(20, Math.floor((cols * 2) / 5)), onLine: send });

    /** The mode plan mode was entered from ("" before it was), and the approval mode it was entered from. */
    let beforePlan = "";
    let beforePlanApproval = "ask";
    const modeValues = (): string[] => api.agent.choices().modes.map((m) => m.value);
    const hasPlan = (): boolean => modeValues().includes("plan");
    /** Switch the agent to its plan mode, remembering what it was. */
    const enterPlan = (): void => {
      const now = api.agent.mode();
      if (now !== "plan") beforePlan = now;
      if (hasPlan()) api.agent.setMode("plan");
    };
    /** Put the agent back in the mode plan mode was entered from, as togglePlan does. */
    const leavePlan = (): void => {
      if (!hasPlan()) return;
      const modes = modeValues();
      const mode = beforePlan.length > 0 && beforePlan !== "plan" ? beforePlan : modes.includes("bypassPermissions") ? "bypassPermissions" : (modes.find((m) => m !== "plan") ?? "");
      api.agent.setMode(mode);
    };
    const tellApproval = (mode: string): void => {
      api.tell(
        mode === "auto"
          ? "mode: auto (reads and edits in the folder go through)"
          : mode === "plan"
            ? "mode: plan"
            : mode === "full"
              ? "mode: Full access (nothing asks, subagents included)"
              : "mode: ask",
      );
    };
    /** Use approval `mode`, switching the agent's plan mode around it. */
    const applyApproval = (mode: string): void => {
      const now = api.agent.approval();
      if (mode === now) return tellApproval(mode);
      if (now === "plan") leavePlan();
      if (mode === "plan") {
        beforePlanApproval = now;
        enterPlan();
      }
      const why = api.agent.setApproval(mode);
      if (why.length > 0) return api.tell(why);
      tellApproval(mode);
    };
    const CYCLE = ["ask", "auto", "plan", "full"];
    const cycleApproval = (): void => {
      const now = api.agent.approval();
      const at = CYCLE.indexOf(now);
      applyApproval(CYCLE[(at + 1) % CYCLE.length]);
    };
    /** /plan: to plan, or back to the mode it was entered from. */
    const togglePlan = (): void => {
      if (api.agent.approval() === "plan") applyApproval(beforePlanApproval);
      else applyApproval("plan");
    };
    // The agent may leave plan mode on its own (a plan approved): the approval mode follows it back to the mode before plan.
    let agentMode = api.agent.mode();
    api.on("conversationChanged", () => {
      const now = api.agent.mode();
      const left = agentMode === "plan" && now !== "plan";
      agentMode = now;
      if (left && api.agent.approval() === "plan") api.agent.setApproval(beforePlanApproval);
    });
    const modeCommand = (mode: string): void => {
      const wanted = mode.trim();
      if (wanted.length === 0) return api.tell("mode: " + api.agent.approval() + " (Shift+Tab cycles ask, auto, plan, full)");
      if (!CYCLE.includes(wanted)) return api.tell("/mode takes ask, auto, plan or full (now " + api.agent.approval() + ")");
      applyApproval(wanted);
    };

    api.commands.add({
      name: "/new",
      help: "a fresh session",
      run: () => {
        api.agent.reset();
        api.chat.showChat();
        api.actions.focus("chat");
        api.tell("new session");
      },
    });
    api.commands.add({
      name: "/compact",
      usage: "[instructions]",
      help: "summarize the conversation so far, freeing context",
      run: (instructions) => {
        // Claude Code's own /compact, sent as a message; the chat and the status bar follow it.
        const r = api.agent.send("/compact" + (instructions.length > 0 ? " " + instructions : ""));
        api.tell(r.error.length > 0 ? r.error : "compacting the conversation…");
      },
    });
    api.commands.add({
      name: "/btw",
      usage: "<question>",
      help: "a side question, answered in the chat and kept out of the conversation",
      run: (question) => {
        if (question.trim().length === 0) return api.tell("/btw <question>: " + api.agent.info().name + " answers it apart from the conversation, while it works too");
        const why = api.agent.sideQuestion(question.trim());
        if (why.length > 0) api.tell(why);
      },
    });
    api.commands.add({ name: "/quit", help: "leave widecode", run: () => api.actions.quit() });
    api.commands.add({ name: "/exit", help: "leave widecode", run: () => api.actions.quit() });
    api.commands.add({ name: "/plan", help: "plan mode on, or the mode before it", run: togglePlan });
    api.commands.add({
      name: "/mode",
      usage: "[ask|auto|plan|full]",
      help: "what asks for permission (no argument for the mode)",
      run: modeCommand,
    });
    api.commands.add({
      name: "/open",
      usage: "<folder>",
      help: "switch folders",
      run: (folder) => {
        if (folder.length === 0) api.tell("/open <folder> (relative to this one, absolute, or under ~)");
        else api.actions.openFolder(folder);
      },
    });

    api.keys.add("", "chat", "Enter sends", () => false);
    api.keys.action({
      id: "chat.plan",
      help: "mode",
      key: "shift+tab",
      run: () => {
        cycleApproval();
        return true;
      },
    });
    api.keys.add("", "chat", "@ file", () => false);
    api.keys.action({
      id: "chat.top",
      scope: "chat",
      key: "ctrl+home",
      run: () => {
        api.chat.loadEarlier();
        api.chat.toTop();
        return true;
      },
    });
    api.keys.action({
      id: "chat.end",
      scope: "chat",
      key: "ctrl+end",
      run: () => {
        api.chat.toEnd();
        return true;
      },
    });
  },
});

export {};
