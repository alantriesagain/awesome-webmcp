// The chat: the conversation with the agent in the first column, the composer under it, drawn by
// the core's chat widget (with the agent's questions, plans and permissions, and the @ completion
// strip). A line from the composer runs the command it starts with, else goes to the agent (with
// images attached by path). It owns the commands about the session as a whole (/new, /compact,
// /quit, /exit, /plan, /open, and /btw, a side question the agent answers apart from the
// conversation, while it works too), Shift+Tab for plan mode (when the agent has one: back to the
// mode before it) and Ctrl+Home / Ctrl+End (the conversation's start, loading what came earlier,
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

    /** The mode plan mode was entered from ("" before it was). */
    let beforePlan = "";
    const togglePlan = (): void => {
      const name = api.agent.info().name;
      const modes = api.agent.choices().modes.map((m) => m.value);
      if (!modes.includes("plan")) return api.tell(name + " has no plan mode");
      const now = api.agent.mode();
      let mode = "plan";
      if (now === "plan") mode = beforePlan.length > 0 && beforePlan !== "plan" ? beforePlan : modes.includes("bypassPermissions") ? "bypassPermissions" : (modes.find((m) => m !== "plan") ?? "");
      else beforePlan = now;
      const error = api.agent.setMode(mode);
      api.tell(error.length > 0 ? "cannot start " + name + ": " + error : mode === "plan" ? "plan mode: " + name + " plans and asks before changing anything" : "plan mode off");
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
    api.commands.add({ name: "/plan", help: "toggle plan mode", run: togglePlan });
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
      help: "plan",
      key: "shift+tab",
      run: () => {
        togglePlan();
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
