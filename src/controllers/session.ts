// The session as the host holds it: the conversation with the agent (another folder opens with a
// conversation of its own), the agents plugins brought and the one talked to, whether the folder
// is trusted (the agent works there and its harness runs), the store, the folder's session records
// (a light model over .widecode/sessions.jsonl, followed live) and the title writer, the
// folder's message history, the project's harness and the user's config parts the harness is
// merged over. The agent chosen and the trust are signals; the hooks announce the conversation's
// changes to plugins. One of light's controllers, as the app's state is.
import { join } from "node:path";
import { signal } from "@lightstart/light/native/tui";
import { Controller } from "@lightstart/light/controller/class.ts";
import { Agent } from "../conversation/agent.ts";
import { activityOf, stepOf } from "../conversation/activity.ts";
import { Conversation } from "../conversation/conversation.ts";
import { Hook } from "@lightstart/lib/hook.ts";
import { Harness, mergePermissions, PermissionRules } from "../services/harness.ts";
import { PromptHistory } from "../conversation/history.ts";
import { SessionRecords } from "../services/sessions.ts";
import { Store } from "../services/store.ts";
import { Titler } from "../agent/titles.ts";

export class SessionController extends Controller {
  conversation: Conversation;
  /** The project's harness, `.widecode/` in the folder. */
  harness: Harness;
  /** Whether the user trusts the folder: the agent works here and the folder's harness runs. True without a store; else as the store remembers, until /trust. */
  readonly trusted = signal(true);
  /** The agent the conversation talks to ("claude": Claude Code, the core's). */
  readonly agentId = signal("claude");
  /** The agents plugins brought. */
  readonly agents: Agent[] = [];
  /** widecode's store (null with --ephemeral) and the title writer, shared by every conversation. */
  store: Store | null = null;
  /** The folder's session records over the sessions model (null without a store). */
  records: SessionRecords | null = null;
  /** The folder's session records changed (a row landed). */
  readonly sessionsChanged = new Hook();
  readonly titler = new Titler();
  /** The messages written in this folder (src/conversation/history.ts); this run's only without a store. */
  history = new PromptHistory("");
  /** config.json's "plugins", "columns" and "permissions" as the user wrote them, for the project's harness to be merged over. */
  userPlugins: unknown = null;
  userColumns: unknown = null;
  userPermissions: unknown = null;
  readonly conversationChanged = new Hook();
  /** A request became open in the request panel: its id, category, name and a one-line summary. */
  readonly requestOpened = new Hook();
  /** A message is about to be sent to the agent (`conversation` not started yet for a new session). */
  readonly messageSending = new Hook();
  /** The tools plugins offer the agents changed: one added, or its plugin gone. */
  readonly toolsChanged = new Hook();
  /** The project's harness changed what the agent gets (its prompt, its trust). */
  readonly harnessChanged = new Hook();
  /** Called with a line worth logging. */
  onNote: ((text: string) => void) | null = null;

  constructor(conversation: Conversation, folder: string) {
    super("session");
    this.conversation = conversation;
    this.harness = new Harness(folder);
    this.harness.userPromptPath = this.userPromptPath();
    this.wire(conversation);
  }

  /** The user-wide prompt, `prompt.md` in the store's root ("" without a store). */
  private userPromptPath(): string {
    return this.store !== null ? join(this.store.root, "prompt.md") : "";
  }

  private wire(c: Conversation): void {
    c.store = this.records;
    c.onChange = () => this.conversationChanged.fire();
    c.onNote = (text: string) => this.note(text);
  }

  /** Give the session its store (the entry does, before the first conversation starts); `folder` is the one open. */
  async useStore(store: Store | null, folder: string): Promise<void> {
    this.store = store;
    this.harness.userPromptPath = this.userPromptPath();
    this.setTrusted(store === null || store.trusted(folder));
    if (store !== null) {
      const records = new SessionRecords(store, this.sessionsChanged);
      records.onNote = (text: string) => this.note(text);
      this.records = records;
      await records.open(folder);
    }
    this.conversation.store = this.records;
    this.history = new PromptHistory(store !== null ? join(folder, ".widecode") : "");
    // A fresh status that starts from the limits the store saw last.
    this.conversation.reset();
  }

  /** Trust the folder from now on, or not: the harness follows. */
  setTrusted(on: boolean): void {
    this.trusted.value = on;
    this.harness.trusted = on;
  }

  /**
   * Talk in `folder` from now on, through `next` (the conversation before is killed; the agent,
   * the model and the effort carry over, and the agent chosen talks to it too; it starts once
   * the folder is trusted).
   */
  async open(next: Conversation, folder: string): Promise<void> {
    const previous = this.conversation;
    previous.kill();
    next.executable = previous.executable;
    next.modelName = previous.modelName;
    next.effort = previous.effort;
    for (const a of previous.extraArgs) next.extraArgs.push(a);
    this.conversation = next;
    // Keep the agent attached until the new folder's plugins have loaded: the chosen one may be
    // replaced by the folder, and starting it before that would start the one about to retire.
    next.agent = previous.agent;
    previous.agent.attach(next);
    this.harness.stopWatching();
    this.harness = new Harness(folder);
    this.harness.userPromptPath = this.userPromptPath();
    this.setTrusted(this.store === null || this.store.trusted(folder));
    const records = this.records;
    if (records !== null) await records.open(folder);
    this.wire(next);
    this.history = new PromptHistory(this.store !== null ? join(folder, ".widecode") : "");
  }

  /**
   * Show session `id`, titled `title` (or as its record keeps it), through the agent it belongs
   * to: the one its record names, chosen first when it is another; the one chosen when the record
   * names none. Answers "" or why that agent could not be chosen (nothing resumed then).
   */
  resumeSession(id: string, title: string): string {
    const records = this.records;
    const meta = records !== null ? records.session(id, this.conversation.folder) : null;
    const owner = meta !== null ? meta.agent : "";
    if (owner.length > 0 && owner !== this.conversation.agent.id()) {
      const why = this.useAgent(owner);
      if (why.length > 0) return why;
    }
    this.conversation.resume(id, title.length > 0 ? title : meta !== null ? meta.title : "");
    return "";
  }

  /** Add plugin `owner`'s agent; the conversation talks to it when it is the one chosen. */
  addAgent(owner: string, a: Agent): void {
    a.owner = owner;
    for (let i = this.agents.length - 1; i >= 0; i--) if (this.agents[i].id() === a.id()) this.agents.splice(i, 1);
    this.agents.push(a);
    if (a.id() === this.agentId.peek()) this.useAgent(a.id());
  }

  /** Talk to agent `id` from now on ("claude" for "", the default); "" or why not. */
  useAgent(id: string): string {
    const c = this.conversation;
    const want = id.length > 0 ? id : "claude";
    for (const a of this.agents)
      if (a.id() === want) {
        if (c.agent !== a) {
          c.agent.kill();
          a.attach(c);
          c.agent = a;
          c.info.modelHint = c.modelHintFor(c.modelName);
          c.refreshLimits();
        }
        this.agentId.value = want;
        c.changed();
        return "";
      }
    const known = this.agents.map((a: Agent) => a.id());
    return "no agent named " + want + (known.length > 0 ? " (there are " + known.join(", ") + ")" : " (no plugin brings one)");
  }

  /** Drop the agents plugin `owner` brought. */
  removeOwner(owner: string): void {
    for (let i = this.agents.length - 1; i >= 0; i--) if (this.agents[i].owner === owner) this.agents.splice(i, 1);
  }

  /** The session's status data (conversation/status-info.ts) brought up to what the conversation and the folder (on `branch`) say. */
  syncInfo(branch: string): void {
    const c = this.conversation;
    const m = c.model;
    const info = c.info;
    info.title = c.title;
    info.branch = branch;
    info.effort = m.effort.length > 0 ? m.effort : c.effort;
    info.queued = m.pending.length;
    info.activity = activityOf(m);
    const step = stepOf(m);
    info.activitySince = step !== null ? step.startedAt : 0;
    if (info.sessionId.length === 0) info.sessionId = c.sessionId;
    if (m.permissionMode.length > 0) info.mode = m.permissionMode;
  }

  /** Why the agent cannot work here ("" when it can): the folder is not trusted. */
  untrusted(): string {
    return this.trusted.peek() ? "" : "this folder is not trusted: /trust lets " + this.conversation.agent.name() + " work here";
  }

  /** The tool permission rules in force: the user's with the trusted project's ask and deny rules added. */
  permissions(): PermissionRules {
    return mergePermissions(this.userPermissions, this.harness.config().permissions);
  }

  /** Keep a message the user wrote in `folder`, for the composer's ↑ (the project's .widecode/ ignores itself first). */
  remember(text: string, folder: string): void {
    const store = this.store;
    if (store !== null) store.ignoreIn(folder, true);
    this.history.add(text, this.conversation.sessionId, Date.now());
  }

  private note(text: string): void {
    const fn = this.onNote;
    if (fn !== null) fn(text);
  }
}
