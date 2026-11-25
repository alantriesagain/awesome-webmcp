// The agents section: each entry the conversation can talk to, the defaults the plugin ships
// (opencode, the DeepSeek Harness, lightcode's harness), and the reading of an entry from config.json.

import { obj, str, list } from "./json.ts";

export interface Entry {
  name: string;
  command: string[];
  /** A command that prints the agent's sessions as JSON ([] for none). */
  sessions: string[];
  /** A command that prints the tools of the mode named in it as {mode}, as JSON ([] for none). */
  tools: string[];
  /** A command that prints the agent's skills as JSON (a list of name, description and location; [] for none). */
  skills: string[];
  /** A command that deletes the session named in it as {session} (a side question's fork; [] for none). */
  forget: string[];
  /** Whether the agent takes a prompt into the turn that runs (opencode does): a message queued meanwhile goes after its next call. */
  midTurn: boolean;
  /** lightcode's own agent, the harness: the project's prompt and trust go to it in `_meta.lightcode`, and `{lightcode}` in its commands is the running binary. */
  own: boolean;
}

export const DEFAULT_AGENTS: Record<string, Entry> = {
  opencode: {
    name: "opencode",
    command: ["opencode", "acp"],
    sessions: ["opencode", "session", "list", "--format", "json"],
    tools: ["opencode", "debug", "agent", "{mode}"],
    skills: ["opencode", "debug", "skill"],
    forget: ["opencode", "session", "delete", "{session}"],
    midTurn: true,
    own: false,
  },
  dsh: {
    name: "DeepSeek Harness",
    command: ["dsh", "--profile", "acp"],
    sessions: [],
    tools: [],
    skills: [],
    forget: [],
    midTurn: false,
    own: false,
  },
  harness: {
    name: "harness",
    command: ["{lightcode}", "--harness"],
    sessions: ["{lightcode}", "--harness-sessions"],
    tools: ["{lightcode}", "--harness-tools", "{mode}"],
    skills: ["{lightcode}", "--harness-skills"],
    forget: ["{lightcode}", "--harness-forget", "{session}"],
    midTurn: true,
    own: true,
  },
};

/** `words` with `{lightcode}` made the running binary's path (the harness's commands). */
export const resolved = (api: lightcode.Api, words: string[]): string[] => words.map((w) => (w === "{lightcode}" ? api.fs.executable() : w));

/** The section's agents over the defaults: an entry needs a command (a list of words). */
export const agentsOf = (section: unknown): Record<string, Entry> => {
  const out: Record<string, Entry> = { ...DEFAULT_AGENTS };
  const agents = obj(obj(section)?.agents);
  if (agents === null) return out;
  for (const id of Object.keys(agents)) {
    const e = obj(agents[id]);
    const words = (v: unknown): string[] => list(v).filter((w): w is string => typeof w === "string" && w.length > 0);
    const command = words(e?.command);
    if (e === null || command.length === 0) continue;
    out[id] = { name: str(e.name).length > 0 ? str(e.name) : id, command, sessions: words(e.sessions), tools: words(e.tools), skills: words(e.skills), forget: words(e.forget), midTurn: e.midTurn === true, own: e.own === true };
  }
  return out;
};
