// What every plugin is given: the kernel (commands, keys, settings); three controllers of light's
// holding the app's state, the screen (src/screen: the columns, tabs, band and segments, the
// active column, the message, the focus), the folder (@lightstart/workspace/folder.ts: the files, the git status,
// the compare base, the tree) and the session (controllers/session.ts: the conversation with the agent,
// the agents, the trust, the store, the harness); the hooks announcing a change, reached here by
// name; the role slots one plugin fills for the others (the code column, the chat, the tools); the
// keymaps; the log; and what crosses the three: loading, the changes with the agent's edits marked,
// opening another folder, a plugin's removal.
import { ConversationHolder } from "../conversation/model-source.ts";
import { ChatModel, Item } from "../conversation/model.ts";
import { existsSync, statSync } from "node:fs";
import { expandHome } from "@lightstart/lib/paths.ts";
import { resolve } from "node:path";
import { Conversation } from "../conversation/conversation.ts";
import { removeLanguages } from "@lightstart/highlight/registry.ts";
import { Hook } from "@lightstart/lib/hook.ts";
import { KeymapController } from "./keymaps.ts";
import { ApprovalController } from "./approval.ts";
import { hookOn } from "./after-change.ts";
import { computed, signal } from "@lightstart/light/signals";
import { Roles } from "./roles.ts";
import { Kernel } from "@lightstart/kernel/kernel.ts";
import { FileChange } from "@lightstart/workspace/changes.ts";
import { Harness } from "../services/harness.ts";
import { Store } from "../services/store.ts";
import type { Workspace } from "@lightstart/workspace/workspace.ts";
import { FolderController, FolderHooks } from "@lightstart/workspace/folder.ts";
import { ScreenController } from "../screen/screen.ts";
import { SessionController } from "./session.ts";

/** A hook plugins listen to, and the name they listen to it under. */
export class NamedHook {
  readonly name: string;
  readonly hook: Hook;

  constructor(name: string, hook: Hook) {
    this.name = name;
    this.hook = hook;
  }
}

/** How many log lines the host keeps for plugins to read. */
const NOTES_KEPT = 300;

export class Host extends ConversationHolder {
  readonly kernel: Kernel;
  readonly screen: ScreenController;
  /** The folder open. `/open` starts the app again over another folder, with a host of its own. */
  readonly folder: FolderController;
  readonly session: SessionController;
  /** The hooks plugins listen to, by name. */
  readonly hooks: NamedHook[];
  /** The folder's announcements: its files, status and base loaded or changed. */
  get folderHooks(): FolderHooks {
    return this.folder.hooks;
  }
  /** What the code column shows: a file, a subagent's steps or a call (null for nothing). */
  readonly shown = signal<object | null>(null);
  /** The keymaps, and the roles plugins play. */
  readonly keys: KeymapController;
  /** The session's approval mode: what asks for permission. */
  readonly approval: ApprovalController;
  readonly roles = new Roles();
  /** The keymap in use changed (/keymap, or the one kept for this run read). */
  /** The keymap in use: "default" (readline's keys alone), or one a plugin brought (its id); emacs unless config.json or /keymap says otherwise. */
  /** The keymaps plugins brought. */
  /** Reads the user's keys.json as text ("" for none); set by main. */
  /** Called with lines worth logging; on quitting; on F12. */
  onLog: ((text: string) => void) | null = null;
  onQuit: (() => void) | null = null;
  /** Start the app again over another folder (the widecode controller); set once the app is composed. */
  onOpen: ((folder: string) => Promise<void>) | null = null;
  onDump: (() => void) | null = null;
  /** The last lines of the log, for a plugin's state.log. */
  readonly notes: string[] = [];
  /**
   * The program that runs as the peers daemon (`<it> --peers-daemon`): the widecode binary itself,
   * set by the real entry alone (startup.ts, never under --selftest). Empty, the peers bridge only
   * looks for a daemon and never starts one: a test, or any other program hosting the app, must not
   * run itself again. The daemon it would start ran the app, whose plugin started another, once.
   */
  peersLauncher = "";
  /**
   * Whether this is the real app the user runs (startup.ts), not a test or a selftest: a plugin
   * that reaches the user's desktop alerts only here. The real entry sets it; composeWidecode does not.
   */
  real = false;
  private editSeq = 0;
  /** The requests already announced, and the model they belong to (a new conversation or a reset clears them). */
  private readonly seenRequests = new Set<string>();
  private requestModel: ChatModel | null = null;
  private pendingOpen = "";
  private pendingOpenAt = 0;
  private opening = false;

  /** Over the start's `folder` and `session`, its `kernel` and the `screen` and `keys` built on it. */
  constructor(folder: FolderController, session: SessionController, kernel: Kernel, screen: ScreenController, keys: KeymapController, approval: ApprovalController) {
    super();
    this.kernel = kernel;
    this.screen = screen;
    this.keys = keys;
    this.approval = approval;
    this.folder = folder;
    this.session = session;
    // The one list of the hooks plugins listen to (widecode.d.ts and PLUGINS.md name the same ones: test/api.test.ts).
    this.hooks = [
      new NamedHook("conversationChanged", session.conversationChanged),
      new NamedHook("sessionsChanged", hookOn("sessionsChanged", computed(() => [session.sessionRows.value, session.skillRows.value]))),
      new NamedHook("filesLoaded", folder.hooks.filesLoaded),
      new NamedHook("statusLoaded", folder.hooks.statusLoaded),
      new NamedHook("folderChanged", folder.hooks.folderChanged),
      new NamedHook("baseChanged", folder.hooks.baseChanged),
      new NamedHook("fileShown", hookOn("fileShown", this.shown)),
      new NamedHook("requestOpened", session.requestOpened),
      new NamedHook("messageSending", session.messageSending),
      new NamedHook("keymapChanged", hookOn("keymapChanged", keys.keymap)),
      new NamedHook("approvalChanged", hookOn("approvalChanged", approval.approval)),
      new NamedHook("messageChanged", hookOn("messageChanged", screen.message)),
      new NamedHook("toolsChanged", hookOn("toolsChanged", session.tools)),
      new NamedHook("harnessChanged", hookOn("harnessChanged", session.harnessState)),
    ];
    this.screen.onNote = (text: string) => this.note(text);
    this.folder.onNote = (text: string) => this.note(text);
    this.session.onNote = (text: string) => this.note(text);
    // First, so every plugin hearing the change reads current status data and changes.
    this.session.conversationChanged.add("host", () => {
      this.session.syncInfo(this.folder.branch());
      this.sawEdit();
      this.noteRequests();
    });
  }

  get workspace(): Workspace {
    return this.folder.workspace;
  }

  get conversation(): Conversation {
    return this.session.conversation;
  }

  override current(): Conversation {
    return this.session.conversation;
  }

  get harness(): Harness {
    return this.session.harness;
  }

  /**
   * Announce each request that is open since the last change, from the model's own list: a request
   * under a background subagent's card in an earlier turn counts, one answered or cancelled before
   * the change does not.
   */
  private noteRequests(): void {
    const model = this.conversation.model;
    if (model !== this.requestModel) {
      this.requestModel = model;
      this.seenRequests.clear();
    }
    // A resumed session's history brings its old requests back; they are not new to the user.
    const loading = this.conversation.starting;
    for (const item of model.allRequests()) {
      const id = item.requestId;
      if (id.length === 0 || this.seenRequests.has(id)) continue;
      this.seenRequests.add(id);
      if (loading || item.state !== "open") continue;
      this.session.requestOpened.fire(this.requestNotice(item));
    }
  }

  /** What a plugin needs to describe request `item`: its id, category, name and one line of what it asks. */
  private requestNotice(item: Item): unknown {
    const asked = item.questions.length > 0 ? item.questions[0].question : item.text;
    const summary = (item.summary.length > 0 ? item.summary : asked.length > 0 ? asked : item.name).split("\n")[0].trim();
    return { id: item.requestId, category: item.category, name: item.name, summary: summary };
  }

  /** The agent's latest edit, as a change to its file now. */
  private sawEdit(): void {
    const m = this.conversation.model;
    if (m.editSeq === this.editSeq) return;
    this.editSeq = m.editSeq;
    const rel = this.folder.relative(m.lastEdit);
    if (rel.length > 0) this.folder.noteEdit(rel);
  }

  /** The changed files against the compare base, newest first: their marks and lines, when each changed, the agent's edits marked. */
  changes(): FileChange[] {
    const claude = new Set<string>();
    for (const p of this.conversation.model.edited) {
      const rel = this.folder.relative(p);
      if (rel.length > 0) claude.add(rel);
    }
    return this.folder.changes(claude);
  }

  /** Give the session its store (the entry does, before the first conversation starts). */
  useStore(store: Store | null): Promise<void> {
    return this.session.useStore(store, this.workspace.folder);
  }

  /** The hook plugins listen to under `name`; null for an unknown name. */
  hook(name: string): Hook | null {
    const found = this.hooks.find((n) => n.name === name);
    return found !== undefined ? found.hook : null;
  }

  /** The keymaps there are: default, then the plugins'. */
  /** Drop everything plugin `owner` put on the host: columns, tabs, band parts, segments, agents, keymaps, hook listeners, roles, languages. */
  removeOwner(owner: string): void {
    this.screen.removeOwner(owner);
    this.session.removeOwner(owner);
    this.keys.removeOwner(owner);
    this.roles.removeOwner(owner);
    removeLanguages(owner);
    for (const n of this.hooks) n.hook.remove(owner);
  }

  /** A line for the log, kept (the last NOTES_KEPT) for plugins to read. */
  note(text: string): void {
    this.notes.push(text);
    if (this.notes.length > NOTES_KEPT) this.notes.splice(0, this.notes.length - NOTES_KEPT);
    const fn = this.onLog;
    if (fn !== null) fn(text);
  }

  /** Keep a message the user wrote, for the composer's ↑. */
  remember(text: string): void {
    this.session.remember(text, this.workspace.folder);
  }

  quit(): void {
    this.conversation.kill();
    const fn = this.onQuit;
    if (fn !== null) fn();
  }

  /** Load the file list and git status, then announce the conversation (the screen's first fill). */
  async load(): Promise<void> {
    // A .widecode/ from before it ignored itself would show among the changes.
    const store = this.session.store;
    if (store !== null) store.ignoreIn(this.workspace.folder, false);
    await this.folder.load();
    this.session.conversationChanged.fire();
  }

  /**
   * Switch to another folder: the app starts again over it, with the same agent, CLI, model and
   * effort (the widecode controller's `reopen`). While the agent works, the first `/open` only warns.
   */
  async openFolder(path: string): Promise<void> {
    const target = resolve(this.workspace.folder, expandHome(path));
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      this.screen.tell("not a folder: " + target);
      return;
    }
    if (this.opening) {
      this.screen.tell("already opening a folder");
      return;
    }
    const now = Date.now();
    if (this.conversation.running && (this.pendingOpen !== target || now - this.pendingOpenAt > 10000)) {
      this.pendingOpen = target;
      this.pendingOpenAt = now;
      this.screen.tell(this.conversation.agent.name() + " is still working here: /open it again within 10 s to stop it and switch");
      return;
    }
    this.pendingOpen = "";
    const open = this.onOpen;
    if (open === null) {
      this.screen.tell("no folder can be opened here");
      return;
    }
    this.opening = true;
    try {
      await open(target);
    } finally {
      this.opening = false;
    }
  }
}
