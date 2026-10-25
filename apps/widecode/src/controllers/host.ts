// What every plugin is given: the kernel (commands, keys, settings); three controllers of light's
// holding the app's state, the screen (@widecode/screen: the columns, tabs, band and segments, the
// active column, the message, the focus), the folder (@light/workspace/folder.ts: the files, the git status,
// the compare base, the tree) and the session (controllers/session.ts: the conversation with the agent,
// the agents, the trust, the store, the harness); the hooks announcing a change, reached here by
// name; the role slots one plugin fills for the others (the code column, the chat, the tools); the
// keymaps; the log; and what crosses the three: loading, the changes with the agent's edits marked,
// opening another folder, a plugin's removal.
import { ConversationHolder } from "@widecode/conversation/model-source.ts";
import { existsSync, statSync } from "node:fs";
import { expandHome } from "@light/lib/paths.ts";
import { resolve } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { removeLanguages } from "@light/highlight/registry.ts";
import { Hook } from "@light/lib/hook.ts";
import { KeymapController } from "./keymaps.ts";
import { Roles } from "./roles.ts";
import { Kernel } from "@light/kernel/kernel.ts";
import { FileChange } from "@light/workspace/changes.ts";
import { Harness } from "../services/harness.ts";
import { Store } from "../services/store.ts";
import { openWorkspace, Workspace } from "@light/workspace/workspace.ts";
import { FolderController, FolderHooks } from "@light/workspace/folder.ts";
import { ScreenController } from "@widecode/screen/screen.ts";
import { SessionController } from "./session.ts";

/** The hooks' names, as plugins listen to them. */
export const HOOKS = ["conversationChanged", "sessionsChanged", "filesLoaded", "statusLoaded", "folderChanged", "folderOpened", "baseChanged", "fileShown", "messageSending", "keymapChanged", "messageChanged", "toolsChanged", "harnessChanged"];

/** How many log lines the host keeps for plugins to read. */
const NOTES_KEPT = 300;

export class Host extends ConversationHolder {
  readonly kernel = new Kernel();
  readonly screen: ScreenController;
  /** The folder open; `/open` replaces it, its announcements staying the host's. */
  folder: FolderController;
  readonly folderHooks = new FolderHooks();
  readonly session: SessionController;
  /** The code column shows a file, a subagent's steps or a call. */
  readonly fileShown = new Hook();
  /** Another folder was opened: its files, status and conversation are new. */
  readonly folderOpened = new Hook();
  /** The keymaps, and the roles plugins play. */
  readonly keys: KeymapController;
  readonly roles = new Roles();
  /** The keymap in use changed (/keymap, or the one kept for this run read). */
  /** The keymap in use: "default" (readline's keys alone), or one a plugin brought (its id); emacs unless config.json or /keymap says otherwise. */
  /** The keymaps plugins brought. */
  /** Reads the user's keys.json as text ("" for none); set by main. */
  /** Called with lines worth logging; on quitting; on F12. */
  onLog: ((text: string) => void) | null = null;
  onQuit: (() => void) | null = null;
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
  private editSeq = 0;
  private pendingOpen = "";
  private pendingOpenAt = 0;
  private opening = false;

  constructor(workspace: Workspace, conversation: Conversation) {
    super();
    this.screen = new ScreenController(this.kernel, "chat");
    this.keys = new KeymapController(this.kernel);
    this.folder = new FolderController(workspace, this.folderHooks);
    this.session = new SessionController(conversation, workspace.folder);
    this.screen.onNote = (text: string) => this.note(text);
    this.folder.onNote = (text: string) => this.note(text);
    this.session.onNote = (text: string) => this.note(text);
    // First, so every plugin hearing the change reads current status data and changes.
    this.session.conversationChanged.add("host", () => {
      this.session.syncInfo(this.folder.branch());
      this.sawEdit();
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

  get conversationChanged(): Hook {
    return this.session.conversationChanged;
  }

  get messageChanged(): Hook {
    return this.screen.messageChanged;
  }

  get filesLoaded(): Hook {
    return this.folderHooks.filesLoaded;
  }

  get statusLoaded(): Hook {
    return this.folderHooks.statusLoaded;
  }

  get folderChanged(): Hook {
    return this.folderHooks.folderChanged;
  }

  get baseChanged(): Hook {
    return this.folderHooks.baseChanged;
  }

  get messageSending(): Hook {
    return this.session.messageSending;
  }

  get toolsChanged(): Hook {
    return this.session.toolsChanged;
  }

  get harnessChanged(): Hook {
    return this.session.harnessChanged;
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

  /** Every hook, by the name plugins listen to it under; null for an unknown name. */
  hook(name: string): Hook | null {
    switch (name) {
      case "conversationChanged":
        return this.session.conversationChanged;
      case "sessionsChanged":
        return this.session.sessionsChanged;
      case "filesLoaded":
        return this.folderHooks.filesLoaded;
      case "statusLoaded":
        return this.folderHooks.statusLoaded;
      case "folderChanged":
        return this.folderHooks.folderChanged;
      case "folderOpened":
        return this.folderOpened;
      case "baseChanged":
        return this.folderHooks.baseChanged;
      case "fileShown":
        return this.fileShown;
      case "messageSending":
        return this.session.messageSending;
      case "keymapChanged":
        return this.keys.changed;
      case "toolsChanged":
        return this.session.toolsChanged;
      case "harnessChanged":
        return this.session.harnessChanged;
      case "messageChanged":
        return this.screen.messageChanged;
    }
    return null;
  }

  /** The keymaps there are: default, then the plugins'. */
  /** Drop everything plugin `owner` put on the host: columns, tabs, band parts, segments, agents, keymaps, hook listeners, roles, languages. */
  removeOwner(owner: string): void {
    this.screen.removeOwner(owner);
    this.session.removeOwner(owner);
    this.keys.removeOwner(owner);
    this.roles.removeOwner(owner);
    removeLanguages(owner);
    for (const name of HOOKS) {
      const h = this.hook(name);
      if (h !== null) h.remove(owner);
    }
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
    this.conversationChanged.fire();
  }

  /**
   * Switch to another folder: its files, status and sessions; the conversation starts over there
   * (with the same CLI, model and effort). While the agent works, the first `/open` only warns.
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
    this.opening = true;
    try {
      const old = this.folder;
      // Read the new folder and make its conversation before closing the old one: a folder that
      // cannot be read leaves the app where it was.
      const workspace = await openWorkspace(target, old.workspace.watch.batchMs);
      const next = new Conversation(workspace.folder);
      const nextFolder = new FolderController(workspace, this.folderHooks);
      nextFolder.onNote = (text: string) => this.note(text);
      try {
        old.workspace.close();
        await old.dispose();
      } catch (err) {
        workspace.close();
        throw err;
      }
      this.folder = nextFolder;
      await this.session.open(next, target);
      this.editSeq = next.model.editSeq;
      this.folderOpened.fire();
      await this.load();
      this.screen.tell("opened " + target);
    } finally {
      this.opening = false;
    }
  }
}
