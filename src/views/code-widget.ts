// The code column's widget: a file with its changes against the compare base in place, a commit's
// change of a file (code-view.ts draws them, diff.ts loads them), a subagent's steps
// (agent-source.ts) or a tool call whole (call-source.ts), live while they run. It plays the host's code role once
// a plugin mounts it as a column; the plugin decides what to open and when (following Claude's
// edits, reloading when the folder or the base changes) and binds the keys.
import { agentDescription, agentStatus, agentType, findAgent } from "../conversation/agents.ts";
import { findCall } from "../conversation/calls.ts";
import { toolSummary, RenderContext } from "../conversation/render.ts";
import { AGENT, Item } from "../conversation/model.ts";
import { Column } from "../screen/contributions.ts";
import { CodeTarget } from "../code/target.ts";
import { Host } from "../host/host.ts";
import { Latest } from "@lightstart/lib/timing.ts";
import { Commit } from "@lightstart/workspace/git-log.ts";
import { LineSource } from "@lightstart/light/native/tui/lines.ts";
import { AgentSource } from "../code/agent-source.ts";
import { CallSource } from "../code/call-source.ts";
import { CodePane } from "../code/code-view.ts";
import { CodeFile, loadCode, loadCommitFile } from "../code/diff.ts";
import { CodeTab, CodeTabHost } from "../code/tabs.ts";
import { afterChange } from "../host/after-change.ts";
import { computed } from "@lightstart/light/signals";
import { Binder } from "@lightstart/kernel/actions.ts";
import { type KeyEvent } from "@lightstart/light/native/tui";

export class CodeWidget extends CodeTarget {
  readonly host: Host;
  readonly pane = new CodePane();
  readonly tabs = new CodeTabHost(this.pane);
  private readonly loads = new Latest();

  constructor(host: Host) {
    super();
    this.host = host;
    const active = computed(() => this.tabs.active());
    afterChange(active, () => this.activeChanged(active.peek()));
    this.tabs.onClose = (tab: CodeTab) => this.closed(tab);
  }

  /** Show it as plugin `owner`'s column named `title`, at `order`, and play the code role; what the owner added goes when it does. */
  mount(owner: string, title: string, order: number): void {
    const h = this.host;
    const pane = this.pane;
    const column = new Column("code", title, order, this.tabs.view, (_cols: number) => 0, 0, 1, null, pane.view);
    column.tabHost = this.tabs;
    h.screen.addColumn(owner, column);
    this.owner = owner;
    h.roles.code = this;
    const bind = new Binder(h.kernel.actions, owner, "code");
    bind.add("code.tab.next", ["tab"], "next tab", (_key: KeyEvent) => {
      this.tabs.show((this.tabs.activeIndex() + 1) % this.tabs.labels().length);
      return true;
    });
    h.folderHooks.statusLoaded.add(owner, () => {
      const open = pane.path.peek();
      if (open.length > 0 && pane.commit.peek().length === 0) pane.mark.value = h.folder.markOf(open);
    });
  }

  override openAgent(id: string): void {
    const h = this.host;
    const item = findAgent(h.conversation.model, id);
    if (item === null) {
      h.screen.tell("no such subagent in this session");
      return;
    }
    const found = this.tabs.indexOf(id);
    if (found >= 0) {
      this.tabs.show(found);
      return;
    }
    // From a resumed session its steps are in its own transcript, read once.
    if (item.children.length === 0 && item.task === null) h.conversation.loadSubagent(item);
    const type = agentType(item);
    const description = agentDescription(item);
    const source = new AgentSource(h, id);
    const pane = new CodePane();
    pane.showAgent(source, "Agent · " + type + (description.length > 0 ? ": " + description : ""), agentStatus(item) === "running");
    pane.onPress = (index: number) => this.toggle(pane, index);
    h.note("agent " + id);
    this.tabs.open(new CodeTab(id, description.length > 0 ? type + ": " + description : type, true, pane, source, "agent"));
  }

  override openCall(id: string): void {
    const h = this.host;
    const item = findCall(h.conversation.model, id);
    if (item === null) {
      h.screen.tell("no such call in this session");
      return;
    }
    if (item.category === AGENT) {
      this.openAgent(id);
      return;
    }
    const found = this.tabs.indexOf(id);
    if (found >= 0) {
      this.tabs.show(found);
      return;
    }
    const ctx = new RenderContext();
    ctx.folder = h.workspace.folder;
    const summary = toolSummary(item, ctx).replace(/\s+/g, " ");
    const source = new CallSource(h, id);
    const pane = new CodePane();
    pane.showAgent(source, item.name + (summary.length > 0 ? " · " + summary : ""), false);
    pane.onPress = null;
    h.note("call " + id);
    this.tabs.open(new CodeTab(id, item.name, true, pane, source, "call"));
  }

  override inAgent(): boolean {
    return this.tabs.active() !== this.tabs.code || this.pane.agent.peek().length > 0;
  }

  override closeTab(): boolean {
    return this.tabs.closeActive();
  }

  override activeTab(): { id: string; kind: "code" | "agent" | "call"; title: string } {
    return this.tabs.activeTab();
  }

  override openView(source: LineSource, title: string, onPress: ((row: number) => void) | null): void {
    this.pane.showAgent(source, title, false);
    this.pane.onPress = onPress;
    this.tabs.show(0);
  }

  /** The pane of the tab shown (Code's when it is). Item tabs each have one. */
  shownPane(): CodePane {
    const view = this.tabs.active().view;
    return view instanceof CodePane ? view : this.pane;
  }

  /** The active tab changed: catch its view up and tell the host what it shows. */
  private activeChanged(tab: CodeTab): void {
    const h = this.host;
    if (tab !== this.tabs.code) {
      const view = tab.view;
      if (view instanceof CodePane) view.view.refresh();
      h.shown.value = tab.source;
      return;
    }
    h.shown.value = this.pane.agent.peek().length > 0 ? this.pane.view.source : this.pane.source.file;
  }

  /** A tab closed: drop its source and its press callback. */
  private closed(tab: CodeTab): void {
    const view = tab.view;
    if (view instanceof CodePane) view.onPress = null;
    tab.source = null;
  }

  /** A press on a subagent's step opens or closes it, as in the chat. */
  private toggle(pane: CodePane, index: number): void {
    const line = pane.view.lineAt(index);
    const tag = line !== null ? line.tag : null;
    if (!(tag instanceof Item)) return;
    const why = this.host.conversation.toggle(tag);
    if (why.length > 0) this.host.screen.tell(why);
  }

  override open(path: string): void {
    this.load(path);
  }

  override openCommit(commit: Commit, path: string, mark: string): void {
    this.loadCommit(commit, path, mark);
  }

  override path(): string {
    return this.pane.path.peek();
  }

  override file(): CodeFile {
    return this.pane.source.file;
  }

  override inCommit(): boolean {
    return this.pane.commit.peek().length > 0;
  }

  override position(): string {
    return this.pane.position();
  }

  /** Show `path` with its changes against the base; a later call wins over one still loading. */
  async load(path: string): Promise<void> {
    const h = this.host;
    const ticket = this.loads.next();
    if (path.length === 0) {
      this.pane.clear();
      h.shown.value = null;
      return;
    }
    const mark = h.folder.markOf(path);
    const file = await loadCode(h.workspace.repo, h.workspace.folder, path, mark === "U", h.folder.base.peek().base);
    if (!this.loads.is(ticket)) return;
    this.pane.show(file, h.folder.markOf(path));
    h.note("code " + path + " hunks=" + String(file.hunks.length));
    h.shown.value = file;
  }

  /** Show `path` as `commit` changed it. */
  async loadCommit(commit: Commit, path: string, mark: string): Promise<void> {
    const h = this.host;
    const ticket = this.loads.next();
    const file = await loadCommitFile(h.workspace.repo, h.workspace.folder, commit, path);
    if (!this.loads.is(ticket)) return;
    this.pane.showCommit(file, mark, commit.short + " " + commit.subject);
    h.note("commit " + commit.short + " " + path + " hunks=" + String(file.hunks.length));
    h.shown.value = file;
  }
}
