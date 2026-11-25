// What every plugin is given: the kernel (commands, keys, settings); three controllers of light's
// holding the app's state, the screen (src/screen: the columns, tabs, band and segments, the
// active column, the message, the focus), the folder (@lightstart/workspace/folder.ts: the files, the git status,
// the compare base, the tree) and the session (controllers/session.ts: the conversation with the agent,
// the agents, the trust, the store, the harness); the hooks announcing a change, reached here by
// name; the role slots one plugin fills for the others (the code column, the chat, the tools); the
// keymaps; the log; and what crosses the three: the changes with the agent's edits marked, a
// plugin's removal.
import { ConversationHolder } from "../conversation/model-source.ts";
import { ChatModel, Item } from "../conversation/model.ts";
import { Conversation } from "../conversation/conversation.ts";
import { removeLanguages } from "@lightstart/highlight/registry.ts";
import { KeymapController } from "./keymaps.ts";
import { ApprovalController } from "./approval.ts";
import { afterChange } from "./after-change.ts";
import { type Emitter } from "@lightstart/light/signals";
import { Roles } from "./roles.ts";
import { buildHooks, hookOf, replayHook, type NamedHook } from "./hooks.ts";
import { Kernel } from "@lightstart/kernel/kernel.ts";
import { FileChange } from "@lightstart/workspace/changes.ts";
import { Harness } from "../services/harness.ts";
import type { Workspace } from "@lightstart/workspace/workspace.ts";
import { FolderController } from "@lightstart/workspace/folder.ts";
import { ScreenController } from "../screen/screen.ts";
import { SessionController } from "./session.ts";

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
  /** Fire hook `name` again, so plugins started since catch up with the state the others saw. */
  replay(name: string): void {
    replayHook(this.hooks, name);
  }
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
  /** Start the app again over another folder (the lightcode controller); set once the app is composed. */
  onOpen: ((folder: string) => Promise<void>) | null = null;
  onDump: (() => void) | null = null;
  /** The last lines of the log, for a plugin's state.log. */
  readonly notes: string[] = [];
  /**
   * The program that runs as the peers daemon (`<it> --peers-daemon`): the lightcode binary itself,
   * set by the real entry alone (startup.ts, never under --selftest). Empty, the peers bridge only
   * looks for a daemon and never starts one: a test, or any other program hosting the app, must not
   * run itself again. The daemon it would start ran the app, whose plugin started another, once.
   */
  peersLauncher = "";
  /**
   * Whether this is the real app the user runs (startup.ts), not a test or a selftest: a plugin
   * that reaches the user's desktop alerts only here. The real entry sets it; composeLightcode does not.
   */
  real = false;
  private editSeq = 0;
  /** The requests already announced, and the model they belong to (a new conversation or a reset clears them). */
  private readonly seenRequests = new Set<string>();
  private requestModel: ChatModel | null = null;

  /** Over the start's `folder` and `session`, its `kernel` and the `screen` and `keys` built on it. */
  constructor(folder: FolderController, session: SessionController, kernel: Kernel, screen: ScreenController, keys: KeymapController, approval: ApprovalController) {
    super();
    this.kernel = kernel;
    this.screen = screen;
    this.keys = keys;
    this.approval = approval;
    this.folder = folder;
    this.session = session;
    // The one list of the hooks plugins listen to (lightcode.d.ts and PLUGINS.md name the same ones: test/api.test.ts).
    this.hooks = buildHooks(session, folder, keys, approval, screen);
    this.screen.onNote = (text: string) => this.note(text);
    this.folder.onNote = (text: string) => this.note(text);
    this.session.onNote = (text: string) => this.note(text);
    // First, so every plugin hearing the change reads current status data and changes.
    afterChange(this.session.conversationState, () => {
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
      this.session.requestOpened.emit(this.requestNotice(item));
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

  /** The hook plugins listen to under `name`; null for an unknown name. */
  hook(name: string): Emitter<unknown> | null {
    return hookOf(this.hooks, name);
  }

  /** The keymaps there are: default, then the plugins'. */
  /** Drop everything plugin `owner` put on the host: columns, tabs, band parts, segments, agents, keymaps, hook listeners, roles, languages. */
  removeOwner(owner: string): void {
    this.screen.removeOwner(owner);
    this.session.removeOwner(owner);
    this.keys.removeOwner(owner);
    this.roles.removeOwner(owner);
    removeLanguages(owner);
    for (const n of this.hooks) n.hook.off(owner);
  }

  /** A line for the log, kept (the last NOTES_KEPT) for plugins to read. */
  note(text: string): void {
    this.notes.push(text);
    if (this.notes.length > NOTES_KEPT) this.notes.splice(0, this.notes.length - NOTES_KEPT);
    const fn = this.onLog;
    if (fn !== null) fn(text);
  }
}
