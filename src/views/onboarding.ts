// The first run and a folder's first access, as questions in the request panel, one after the
// other: on the first run with a store, a welcome in the chat (/welcome shows it again), then which
// agent to talk to and which model; in any folder not yet trusted, whether to trust it, with what it
// carries that the agent reads and runs (its instruction files, its settings and hooks, its MCP
// servers, its own lightcode harness) and what trusting means, as Claude Code asks for a folder;
// last, on the first run, which keys to use. The questions go through the conversation's own asks,
// so they show and answer as an agent's would, and the composer's text goes to them until they are
// answered. Nothing here reaches light.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Kernel } from "@lightstart/kernel/kernel.ts";
import { Command } from "@lightstart/kernel/commands.ts";
import { Ask } from "../conversation/requests.ts";
import folderController from "../controllers/folder.ts";
import kernelController from "../controllers/kernel.ts";
import keymapController from "../controllers/keymap.ts";
import screenController from "../controllers/screen.ts";
import sessionController from "../controllers/session.ts";

/** A plugin file of a harness as the trust question lists it: its path from the folder, the ids it registers, why it does not load ("" when it does). */
export class HarnessFile {
  readonly file: string;
  readonly ids: string[];
  readonly error: string;

  constructor(file: string, ids: string[], error: string) {
    this.file = file;
    this.ids = ids;
    this.error = error;
  }
}

/** What a folder carries that the agent reads or lightcode runs: the agent's files present, and the harness's parts. */
export class FolderCarries {
  /** The agent's own files, by path from the folder: CLAUDE.md, .claude/settings.json, .mcp.json, ... */
  agentFiles: string[] = [];
  harnessFiles: HarnessFile[] = [];
  promptLength = 0;
  configKeys: string[] = [];

  any(): boolean {
    return this.agentFiles.length + this.harnessFiles.length + this.promptLength + this.configKeys.length > 0;
  }
}

/** An agent the user may talk to, as the agent question lists it. */
export class AgentChoice {
  readonly id: string;
  readonly name: string;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }
}

/** What the onboarding asks and whom it tells: the first run's questions, the folder's, and what each answer does. */
export class Onboarding {
  /** The first run with this store: the welcome, the agent, the model and the keys are asked. */
  firstRun = false;
  /** Whether the folder is trusted already (then it is not asked). */
  trusted = true;
  carries = new FolderCarries();
  agents: AgentChoice[] = [];
  /** The models the model question offers (Claude Code's list), [] for no question. */
  models: string[] = [];
  onAgent: ((id: string) => void) | null = null;
  onModel: ((name: string) => void) | null = null;
  onTrust: (() => void) | null = null;
  onLookOnly: (() => void) | null = null;
  onExit: (() => void) | null = null;
}

/** The files the agent reads or runs in a folder, by path from it. */
const AGENT_FILES = ["CLAUDE.md", "AGENTS.md", ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks", ".claude/skills", ".claude/commands", ".claude/agents", ".mcp.json"];

const KEYMAPS = [
  { name: "default", label: "Default", description: "the common keys: arrows, Home and End, Ctrl+←/→ by a word, Ctrl+Backspace deletes a word, Ctrl+C clears" },
  { name: "emacs", label: "Emacs", description: "the default and readline's: Ctrl+A/E, Ctrl+F/B, Ctrl+P/N by a line, Alt+F/B/D, Alt+< and Alt+>" },
  { name: "vi", label: "Vi", description: "insert and normal modes, Esc between them, motions, counts, operators, a register, undo" },
];

/** The label chosen in a reply as the conversation's asks answer it ("" for none: declined, withdrawn, written in words). */
const chosen = (reply: string): string => {
  const v = JSON.parse(reply) as { state: string; answers: { labels: string[] }[] };
  if (v.state !== "answered" || v.answers.length === 0 || v.answers[0].labels.length === 0) return "";
  return v.answers[0].labels[0];
};

/** One question in the panel, `then` hearing the label chosen ("" for none). */
const askOne = (name: string, header: string, question: string, options: { label: string; description: string }[], then: (label: string) => void): void => {
  const ask = new Ask();
  ask.onReplied = (reply: string) => then(chosen(reply));
  sessionController.current.conversation.ask(ask, { category: "question", name, questions: [{ question, header, options }] });
};

/** The welcome: where things are, the keys that matter first, the commands to start with. */
export const welcomeText = (kernel: Kernel): string => {
  const k = kernel.keys;
  const label = (id: string): string => k.label(id);
  const agent = sessionController.current.conversation.agent.name();
  return (
    "Welcome to lightcode. The chat with " + agent + " is on the left; the tools column shows its calls, the files column this folder and its sessions, the code column the file it edits with the changes. " +
    label("app.focus.chat") + " " + label("app.focus.tools") + " " + label("app.focus.side") + " " + label("app.focus.code") + " go to a column, " + label("app.column.previous") + "/" + label("app.column.next") + " move between them. " +
    "Type a message and Enter sends it; Shift+Enter adds a line; @ completes a file's path, and an image's path attaches it. " + label("app.interrupt") + " interrupts a turn; " + label("app.quit") + " clears the message, and quits when it is empty. " +
    "/help lists every key and command, /model and /effort choose, /plan toggles plan mode, /keymap changes the keys. " +
    "A folder is used once you trust it (/trust), and its .lightcode/ is its harness, plugins and a prompt of its own: /harness shows it, /harness init starts one. /welcome shows this again."
  );
};

/** Put the welcome in the chat. */
export const welcome = (kernel: Kernel): void => {
  const conversation = sessionController.current.conversation;
  conversation.model.notice(welcomeText(kernel), "info", "", "");
  conversation.changed();
};

/** The /welcome command, added by the shell in its command order. */
export const registerWelcome = (kernel: Kernel): void => {
  kernel.commands.add(new Command("/welcome", "", "the welcome: the columns, the keys and commands to start with", "shell", (_arg: string) => welcome(kernel)));
};

/** What `folder` carries that the agent reads or lightcode runs; `checkPlugin(file)` says what a harness plugin file registers or why it does not load. */
export const folderCarries = (checkPlugin: (file: string) => HarnessFile): FolderCarries => {
  const out = new FolderCarries();
  const folder = folderController.current.workspace.folder;
  for (const f of AGENT_FILES) if (existsSync(join(folder, f))) out.agentFiles.push(f);
  const h = sessionController.current.harness;
  for (const file of h.pluginFiles()) out.harnessFiles.push(checkPlugin(file));
  out.promptLength = h.rawPrompt().length;
  const s = h.summary();
  if (s.config) out.configKeys = h.configKeys();
  return out;
};

/** The agents, by name; `then` hears the id chosen. */
export const askAgent = (agents: AgentChoice[], then: (id: string) => void): void => {
  const options = agents.slice(0, 4).map((a) => ({ label: a.name, description: a.id === "claude" ? "Anthropic's agent, through the claude CLI" : a.id + ", over ACP; its CLI must be installed" }));
  askOne("Agent", "Agent", "Which agent do you want to talk to? /agent changes it later.", options, (label: string) => {
    const a = agents.find((x) => x.name === label);
    then(a !== undefined ? a.id : "");
  });
};

/** The models, by name; `then` hears the one chosen ("" for none). */
export const askModel = (models: string[], then: (name: string) => void): void => {
  askOne("Model", "Model", "Which model should a new session start on? /model and F5 change it later.", models.slice(0, 4).map((m) => ({ label: m, description: "" })), then);
};

/** What the folder carries, in words ("" for nothing). */
const carriesText = (c: FolderCarries): string => {
  const parts: string[] = [];
  if (c.agentFiles.length > 0) parts.push("the agent reads " + c.agentFiles.join(", "));
  const harness: string[] = [];
  for (const f of c.harnessFiles) harness.push(f.file + " (" + (f.error.length > 0 ? "does not load: " + f.error : f.ids.length > 0 ? f.ids.join(", ") : "no plugin") + ")");
  if (c.promptLength > 0) harness.push(".lightcode/prompt.md (" + String(c.promptLength) + " characters)");
  if (c.configKeys.length > 0) harness.push(".lightcode/config.json (" + c.configKeys.join(", ") + ")");
  if (harness.length > 0) parts.push("lightcode runs its harness: " + harness.join(", "));
  return parts.join("; ");
};

/**
 * Ask whether to trust the folder: what it carries, what trusting means. `onTrust` trusts it;
 * `onLookOnly` keeps the agent out until /trust (also for Esc); `onExit` quits.
 */
export const askTrust = (carries: FolderCarries, onTrust: () => void, onLookOnly: () => void, onExit: () => void): void => {
  const agent = sessionController.current.conversation.agent.name();
  const what = carriesText(carries);
  const question =
    "Do you trust this folder, " + folderController.current.workspace.folder + "? Trusted, " + agent + " works here with your permission rules and nothing else asked, reads the folder's instruction files, settings and hooks, and runs its MCP servers; the folder's own lightcode harness (.lightcode) runs inside lightcode, with your files and processes" +
    (what.length > 0 ? ". It carries: " + what : "") +
    ". A repository you cloned may carry files you did not write. Your answer holds on every launch here.";
  askOne(
    "Trust",
    "Folder",
    question,
    [
      { label: "Trust this folder", description: agent + " works here, now and on every launch" },
      { label: "Look only", description: "the files and the code, no agent until /trust" },
      { label: "Exit", description: "leave lightcode" },
    ],
    (label: string) => {
      if (label === "Trust this folder") onTrust();
      else if (label === "Exit") onExit();
      else onLookOnly();
    },
  );
};

/** Ask which keymap to use among the ones there are; the choice is kept (setKeymap). */
export const askKeymap = (then: () => void): void => {
  const keys = keymapController.current;
  const names = keys.names();
  const options = KEYMAPS.filter((m) => names.includes(m.name)).map((m) => ({ label: m.label, description: m.description }));
  if (options.length < 2) {
    then();
    return;
  }
  askOne("Keymap", "Keymap", "Which keys do you want in the composer? /keymap changes them later.", options, (label: string) => {
    const m = KEYMAPS.find((x) => x.label === label);
    if (m !== undefined) {
      keys.set(m.name);
      screenController.current.tell("keymap " + m.name + "; /keymap changes it");
    }
    then();
  });
};

/** Run the onboarding `o` calls for: the welcome and the agent, the model, the folder, the keys, each after the one before. */
export const runOnboarding = (o: Onboarding): void => {
  const keys = (): void => {
    if (o.firstRun) askKeymap(() => {});
  };
  const folder = (): void => {
    if (o.trusted) {
      keys();
      return;
    }
    askTrust(
      o.carries,
      () => {
        const fn = o.onTrust;
        if (fn !== null) fn();
        keys();
      },
      () => {
        const fn = o.onLookOnly;
        if (fn !== null) fn();
        keys();
      },
      () => {
        const fn = o.onExit;
        if (fn !== null) fn();
      },
    );
  };
  const model = (agentId: string): void => {
    if (!o.firstRun || agentId !== "claude" || o.models.length < 2) {
      folder();
      return;
    }
    askModel(o.models, (name: string) => {
      const fn = o.onModel;
      if (name.length > 0 && fn !== null) fn(name);
      folder();
    });
  };
  if (o.firstRun) welcome(kernelController.current);
  if (!o.firstRun || o.agents.length < 2) {
    model(sessionController.current.agentId.peek());
    return;
  }
  askAgent(o.agents, (id: string) => {
    const fn = o.onAgent;
    if (id.length > 0 && fn !== null) fn(id);
    model(id.length > 0 ? id : sessionController.current.agentId.peek());
  });
};
