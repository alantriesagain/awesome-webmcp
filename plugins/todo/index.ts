// A todo list for the agent: the `todo` tool lists, adds, toggles and clears items, and `/todos`
// shows the list in a notification. The state lives in the tool results' details
// (`{ todos: [{ id, text, done }], nextId }`), so a session loaded again rebuilds it from the latest
// todo result on its branch. A result's text is the list as lines (`[x] 1 text`, `[ ] 2 text`, and
// "No todos." when it is empty); an add with no text or a toggle of an unknown id is an error and
// leaves the list as it was.

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

interface TodoState {
  todos: Todo[];
  nextId: number;
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** `value` as a todo list state, null when it is not one. */
const stateOf = (value: unknown): TodoState | null => {
  const r = recordOf(value);
  if (r === null || !Array.isArray(r["todos"])) return null;
  const todos: Todo[] = [];
  for (const v of r["todos"] as unknown[]) {
    const t = recordOf(v);
    if (t === null) continue;
    const id = Number(t["id"]);
    if (!Number.isFinite(id)) continue;
    todos.push({ id: id, text: typeof t["text"] === "string" ? String(t["text"]) : "", done: t["done"] === true });
  }
  let nextId = Number(r["nextId"]);
  if (!Number.isFinite(nextId) || nextId < 1) {
    nextId = 1;
    for (const t of todos) if (t.id >= nextId) nextId = t.id + 1;
  }
  return { todos: todos, nextId: nextId };
};

/** The state the latest todo result on a branch holds, null when it holds none. */
const stateOnBranch = (branch: unknown[]): TodoState | null => {
  let found: TodoState | null = null;
  for (const value of branch) {
    const entry = recordOf(value);
    if (entry === null || entry["type"] !== "message") continue;
    const message = recordOf(entry["message"]);
    if (message === null || message["role"] !== "toolResult" || message["toolName"] !== "todo") continue;
    const state = stateOf(message["details"]);
    if (state !== null) found = state;
  }
  return found;
};

/** The list as lines. */
const rendered = (state: TodoState): string => {
  if (state.todos.length === 0) return "No todos.";
  const lines: string[] = [];
  for (const t of state.todos) lines.push("[" + (t.done ? "x" : " ") + "] " + String(t.id) + " " + t.text);
  return lines.join("\n");
};

/** The state as the result's details. */
const detailsOf = (state: TodoState): unknown => {
  const todos: Record<string, unknown>[] = [];
  for (const t of state.todos) todos.push({ id: t.id, text: t.text, done: t.done });
  return { todos: todos, nextId: state.nextId };
};

const PLAN = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "add", "toggle", "clear"], description: "What to do: list the todos, add one, toggle one, or clear the list." },
    text: { type: "string", description: "The item's text, for add." },
    id: { type: "integer", description: "The item's id, for toggle." },
  },
  required: ["action"],
};

widecode.plugin({
  id: "todo",
  agent(agent) {
    let state: TodoState = { todos: [], nextId: 1 };

    /** The answer to a call: the list's text and its details now. */
    const answer = (text: string, error = false): widecode.AgentToolResult => ({ content: [{ type: "text", text: text }], details: detailsOf(state), isError: error });

    agent.on("session_start", (_event, ctx) => {
      const found = stateOnBranch(ctx.sessionManager.getBranch());
      if (found !== null) state = found;
    });

    agent.registerTool({
      name: "todo",
      label: "Todo",
      description: "Keep a list of the work: list it, add an item, toggle one done, or clear it.",
      parameters: PLAN,
      execute(_toolCallId, params) {
        const action = typeof params["action"] === "string" ? String(params["action"]) : "";
        if (action === "add") {
          const text = typeof params["text"] === "string" ? String(params["text"]).trim() : "";
          if (text.length === 0) return answer("The add needs text.", true);
          state.todos.push({ id: state.nextId, text: text, done: false });
          state.nextId++;
          return answer(rendered(state));
        }
        if (action === "toggle") {
          const id = Number(params["id"]);
          const item = Number.isFinite(id) ? state.todos.find((t) => t.id === id) : undefined;
          if (item === undefined) return answer("No todo with id " + String(params["id"]) + ".", true);
          item.done = !item.done;
          return answer(rendered(state));
        }
        if (action === "clear") {
          state = { todos: [], nextId: 1 };
          return answer(rendered(state));
        }
        if (action !== "list") return answer("Unknown action " + JSON.stringify(action) + ": use list, add, toggle or clear.", true);
        return answer(rendered(state));
      },
    });

    agent.registerCommand("todos", {
      description: "Show the todo list",
      handler(_args, ctx) {
        ctx.ui.notify(rendered(state));
      },
    });
  },
});

export {};
