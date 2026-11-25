// The models and efforts: F5, or a press on the model in the status table, switches to the next of
// the config's models for the agent, live when it runs (Claude's prompt cache starts over then); /model
// sets any (for an agent that lists its models, one of them, by its id or a part of its id or name
// that names one), and as it is typed lists the agent's models that hold every word typed, the one
// it runs on first, then the config's, then the rest; /effort sets the agent's effort. The "model"
// segment names the model the session runs on ("Opus 5.5 1M").
//
// What is chosen is kept (state.json): the model, as the agent's default from then on (unless
// --model names one), and the effort, for the model, for its provider (the part of its id before
// "/", else the agent) and overall. A model the agent comes to run on gets the effort kept for it,
// else its provider's, else the last chosen anywhere, when the agent offers it; --effort holds for
// the launch. Its section of config.json: { "list": ["opus[1m]", "fable[1m]"], "agents": {
// "opencode": ["opencode/big-pickle"] }, "effort": { "default": "high", "providers": { "deepseek":
// "low" }, "models": { "deepseek/deepseek-chat": "medium" } } }: "list" is Claude Code's (its first
// the model of a new session until one is chosen), "agents" another agent's by its id, "effort" the
// efforts to start from, under those chosen.

/** The models F5 cycles through for Claude Code when the config lists none; the first is a new session's. */
const T = lightcode.theme;
const DEFAULT_MODELS = ["opus[1m]", "fable[1m]"];

/** A list's non-empty names, trimmed. */
const names = (list: unknown): string[] => {
  const out: string[] = [];
  if (Array.isArray(list)) for (const m of list) if (typeof m === "string" && m.trim().length > 0) out.push(m.trim());
  return out;
};

const record = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** An object's non-empty string fields. */
const strings = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  const o = record(v);
  if (o !== null) for (const [k, x] of Object.entries(o)) if (typeof x === "string" && x.length > 0) out[k] = x;
  return out;
};

/** The section's list for Claude Code; the defaults when there is none. */
const parseModels = (section: unknown): string[] => {
  const out = names(record(section)?.list);
  return out.length > 0 ? out : DEFAULT_MODELS.slice();
};

/** The section's lists for the other agents, by id. */
const parseAgents = (section: unknown): Record<string, string[]> => {
  const agents = record(record(section)?.agents);
  const out: Record<string, string[]> = {};
  if (agents !== null) for (const [id, list] of Object.entries(agents)) out[id] = names(list);
  return out;
};

/** Efforts: one overall, by provider, by model. */
interface Efforts {
  default: string;
  providers: Record<string, string>;
  models: Record<string, string>;
}

const parseEfforts = (v: unknown): Efforts => {
  const o = record(v);
  const d = o?.default;
  return { default: typeof d === "string" ? d : "", providers: strings(o?.providers), models: strings(o?.models) };
};

lightcode.plugin({
  id: "models",
  defaults: () => ({ list: DEFAULT_MODELS }),
  activate(api) {
    const section = api.settings.section();
    const models = parseModels(section);
    const others = parseAgents(section);
    const configured = parseEfforts(record(section)?.effort);
    const kept = record(api.settings.state());
    /** The model chosen last, by agent; the efforts chosen last. */
    const chosen = strings(kept?.chosen);
    const efforts = parseEfforts(kept?.effort);
    const keep = (): void => api.settings.setState({ chosen, effort: efforts });
    const agent = api.agent;
    const id = agent.info().id;
    // A new session runs on the model chosen last for the agent, else the config's first (Claude Code's), unless --model named one.
    if (agent.modelName() === "") {
      const start = chosen[id] ?? (id === "claude" ? models[0] : "");
      if (start.length > 0) agent.useModel(start);
    }
    /** The config's list for the agent; the models the agent offers ([] for any); the model it runs on. */
    const listFor = (): string[] => {
      const now = agent.info().id;
      return now === "claude" ? models : (others[now] ?? []);
    };
    const offered = (): lightcode.AgentOption[] => agent.choices().models;
    const current = (): string => (offered().length > 0 ? agent.reportedModel() || agent.modelName() : agent.modelName());
    /** The provider of `model`: the part of its id before "/", else the agent. */
    const providerOf = (model: string): string => {
      const at = model.indexOf("/");
      return at > 0 ? model.slice(0, at) : agent.info().id;
    };
    const first = (...values: string[]): string => values.find((v) => v.length > 0) ?? "";
    /** The effort for `model`: the one kept for it, its provider's, the last chosen, config.json's under each ("" for none). */
    const effortFor = (model: string): string => {
      const p = providerOf(model);
      return first(efforts.models[model] ?? "", configured.models[model] ?? "", efforts.providers[p] ?? "", configured.providers[p] ?? "", efforts.default, configured.default);
    };
    /** The model the effort was last applied for, or chosen on. */
    let seen = "";
    /** --effort holds for the launch: the first model the agent reports keeps it. */
    let held = agent.effort().length > 0;
    /** The effort kept for `model` goes to the agent when it offers it and does not run on it. */
    const follow = (model: string): void => {
      seen = model;
      const level = effortFor(model);
      if (level.length === 0 || level === agent.effort() || !agent.choices().efforts.some((o) => o.value === level)) return;
      agent.setEffort(level);
    };
    // An agent whose efforts are known now (Claude Code's) starts on the one kept; one that lists its models says them with its session.
    if (!held && agent.choices().efforts.length > 0 && offered().length === 0) follow(agent.modelName());
    api.on("conversationChanged", () => {
      // An agent listing its models reports the one it runs on: the effort kept for it follows.
      if (offered().length === 0) return;
      const model = agent.reportedModel();
      if (model.length === 0 || model === seen) return;
      if (held) {
        held = false;
        seen = model;
        return;
      }
      follow(model);
    });
    const switchTo = (name: string): void => {
      agent.setModel(name);
      chosen[agent.info().id] = name;
      keep();
      // Claude Code's efforts are known: the one kept for the model goes now; another agent reports the model once it switched.
      if (offered().length === 0) follow(name);
      const claude = agent.info().id === "claude";
      api.tell("model " + agent.modelLabel() + (agent.started() ? (claude ? ": the prompt cache starts over" : "") : " from the next message"));
    };
    const cycle = (): void => {
      const info = agent.info();
      const offers = offered().map((o) => o.value);
      const list = offers.length > 0 ? listFor().filter((m) => offers.includes(m)) : listFor();
      if (list.length === 0) {
        api.tell(offers.length > 0 ? "F5 cycles the models config.json lists for " + info.name + " (models.agents." + info.id + "); /model <name> picks one of its " + String(offers.length) : "model: " + (current() || "the agent's default"));
        return;
      }
      const now = current();
      const at = list.indexOf(now);
      const next = list[at < 0 ? 0 : (at + 1) % list.length];
      if (next === now) {
        api.tell("model " + next + " (the config lists no other)");
        return;
      }
      switchTo(next);
    };
    api.ui.segment({
      name: "model",
      draw: (ctx) => {
        const name = String(ctx.info?.model?.display_name ?? "");
        return name.length > 0 ? [{ text: name, fg: T.warn }] : [];
      },
      press: cycle,
    });
    api.keys.action({
      id: "models.next",
      help: "model",
      key: "f5",
      run: () => {
        cycle();
        return true;
      },
    });
    /** The agent's models (the config's list, for one that takes any name) that hold every word of `typed`: the one it runs on, the config's, the rest. */
    const choosable = (typed: string): { value: string; label: string; detail: string }[] => {
      const now = current();
      const favorites = listFor();
      const offers = offered();
      const all = offers.length > 0 ? offers.slice() : favorites.map((m) => ({ value: m, name: "" }));
      if (offers.length === 0 && now.length > 0 && !favorites.includes(now)) all.unshift({ value: now, name: "" });
      const words = typed.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
      const rank = (v: string): number => (v === now ? 0 : favorites.includes(v) ? 1 : 2);
      return all
        .filter((o) => words.every((w) => o.value.toLowerCase().includes(w) || o.name.toLowerCase().includes(w)))
        .sort((a, b) => rank(a.value) - rank(b.value) || (rank(a.value) === 1 ? favorites.indexOf(a.value) - favorites.indexOf(b.value) : a.value.localeCompare(b.value)))
        .map((o) => ({ value: o.value, label: o.value, detail: [o.value === now ? "now" : favorites.includes(o.value) ? "F5" : "", o.name.length > 0 && o.name !== o.value ? o.name : ""].filter((d) => d.length > 0).join(" · ") }));
    };
    api.commands.add({
      name: "/model",
      usage: "<name>",
      help: "the model: type to list the agent's (F5 switches between the config's)",
      complete: choosable,
      run: (arg) => {
        const offers = offered();
        if (arg.length === 0) {
          api.tell("model: " + (agent.reportedModel() || agent.modelName() || "the agent's default") + (offers.length > 0 ? " (" + String(offers.length) + " offered: /model <part of a name>)" : ""));
          return;
        }
        // Claude Code takes any alias; another agent, one of its models.
        if (offers.length === 0) return switchTo(arg);
        const exact = offers.find((o) => o.value === arg);
        const part = arg.toLowerCase();
        const matches = exact !== undefined ? [exact] : offers.filter((o) => o.value.toLowerCase().includes(part) || o.name.toLowerCase().includes(part));
        if (matches.length === 1) return switchTo(matches[0].value);
        api.tell(matches.length === 0 ? "no model of " + agent.info().name + " matches " + arg : arg + " matches " + matches.slice(0, 5).map((o) => o.value).join(", ") + (matches.length > 5 ? ", … (" + String(matches.length) + ")" : ""));
      },
    });
    api.commands.add({
      name: "/effort",
      usage: "<level>",
      help: "the agent's effort, kept for the model, its provider and overall",
      complete: (typed) => {
        const now = agent.effort();
        return agent
          .choices()
          .efforts.filter((e) => e.value.startsWith(typed.trim()))
          .map((e) => ({ value: e.value, label: e.value, detail: e.value === now ? "now" : "" }));
      },
      run: (level) => {
        const levels = agent.choices().efforts.map((e) => e.value);
        const now = agent.effort();
        if (levels.length === 0) return api.tell(agent.info().name + " has no effort to choose");
        if (!levels.includes(level)) return api.tell("effort is one of " + levels.join(", ") + (now.length > 0 ? " (now " + now + ")" : ""));
        agent.setEffort(level);
        const model = current();
        if (model.length > 0) efforts.models[model] = level;
        efforts.providers[providerOf(model)] = level;
        efforts.default = level;
        seen = model;
        keep();
        api.tell("effort " + level);
      },
    });
  },
});

export {};
