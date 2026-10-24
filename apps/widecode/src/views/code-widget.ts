// The code column's widget: a file with its changes against the compare base in place, a commit's
// change of a file (code-view.ts draws them, diff.ts loads them), a subagent's steps
// (agent-source.ts) or a tool call whole (call-source.ts), live while they run. It plays the host's code role once
// a plugin mounts it as a column; the plugin decides what to open and when (following Claude's
// edits, reloading when the folder or the base changes) and binds the keys.
import { agentDescription, agentStatus, agentType, findAgent } from "@widecode/conversation/agents.ts";
import { findCall } from "@widecode/conversation/calls.ts";
import { toolName, toolSummary, RenderContext } from "@widecode/conversation/render.ts";
import { AGENT, Item } from "@widecode/conversation/model.ts";
import { Column } from "@widecode/screen/contributions.ts";
import { CodeTarget } from "@widecode/code/target.ts";
import { Host } from "../controllers/host.ts";
import { Latest } from "@light/lib/timing.ts";
import { Commit } from "@light/workspace/git-log.ts";
import { LineSource } from "@bootstrapp/light/native/tui/lines.ts";
import { AgentSource } from "@widecode/code/agent-source.ts";
import { CallSource } from "@widecode/code/call-source.ts";
import { CodePane } from "@widecode/code/code-view.ts";
import { CodeFile, loadCode, loadCommitFile } from "@widecode/code/diff.ts";

export class CodeWidget extends CodeTarget {
  readonly host: Host;
  readonly pane = new CodePane();
  private readonly loads = new Latest();

  constructor(host: Host) {
    super();
    this.host = host;
  }

  /** Show it as plugin `owner`'s column named `title`, at `order`, and play the code role; what the owner added goes when it does. */
  mount(owner: string, title: string, order: number): void {
    const h = this.host;
    const pane = this.pane;
    h.screen.addColumn(owner, new Column("code", title, order, pane, (_cols: number) => 0, 0, 1, null, pane.view));
    this.owner = owner;
    h.roles.code = this;
    h.statusLoaded.add(owner, () => {
      const open = pane.path.peek();
      if (open.length > 0 && pane.commit.peek().length === 0) pane.mark.value = h.folder.markOf(open);
    });
    h.folderOpened.add(owner, () => pane.clear());
  }

  override openAgent(id: string): void {
    const h = this.host;
    const item = findAgent(h.conversation.model, id);
    if (item === null) {
      h.screen.tell("no such subagent in this session");
      return;
    }
    // From a resumed session its steps are in its own transcript, read once.
    if (item.children.length === 0 && item.task === null) h.conversation.loadSubagent(item);
    const description = agentDescription(item);
    this.pane.showAgent(new AgentSource(h, id), "Agent · " + agentType(item) + (description.length > 0 ? ": " + description : ""), agentStatus(item) === "running");
    this.pane.onPress = (index: number) => this.toggle(index);
    h.note("agent " + id);
    h.fileShown.fire();
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
    const ctx = new RenderContext();
    ctx.folder = h.workspace.folder;
    const summary = toolSummary(item, ctx).replace(/\s+/g, " ");
    const source = new CallSource(h, id);
    const name = toolName(item);
    this.pane.showAgent(source, name + (name.length > 0 && summary.length > 0 ? " · " : "") + summary, false);
    this.pane.onPress = null;
    h.note("call " + id);
    h.fileShown.fire();
  }

  override inAgent(): boolean {
    return this.pane.agent.peek().length > 0;
  }

  override openView(source: LineSource, title: string, onPress: ((row: number) => void) | null): void {
    this.pane.showAgent(source, title, false);
    this.pane.onPress = onPress;
    this.host.fileShown.fire();
  }

  /** A press on a subagent's step opens or closes it, as in the chat. */
  private toggle(index: number): void {
    const line = this.pane.view.lineAt(index);
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
      h.fileShown.fire();
      return;
    }
    const mark = h.folder.markOf(path);
    const file = await loadCode(h.workspace.repo, h.workspace.folder, path, mark === "U", h.folder.base.peek().base);
    if (!this.loads.is(ticket)) return;
    this.pane.show(file, h.folder.markOf(path));
    h.note("code " + path + " hunks=" + String(file.hunks.length));
    h.fileShown.fire();
  }

  /** Show `path` as `commit` changed it. */
  async loadCommit(commit: Commit, path: string, mark: string): Promise<void> {
    const h = this.host;
    const ticket = this.loads.next();
    const file = await loadCommitFile(h.workspace.repo, h.workspace.folder, commit, path);
    if (!this.loads.is(ticket)) return;
    this.pane.showCommit(file, mark, commit.short + " " + commit.subject);
    h.note("commit " + commit.short + " " + path + " hunks=" + String(file.hunks.length));
    h.fileShown.fire();
  }
}
