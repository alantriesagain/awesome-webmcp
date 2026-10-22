// Lines built from the conversation's model, for the panes that draw it: the chat's transcript,
// the tools list, a subagent's steps, a call's page. The lines are built again when the model (a
// reset replaces it), its version, its turn count or the width changes, or on every draw while
// `live()` (a running call's clock); reading the version in a render makes the pane follow it.
// `rebuild` is each source's own. The conversation comes from a holder (an app's host), asked on
// every build, since an app may replace it.
import { Conversation } from "./conversation.ts";
import { ChatModel } from "./model.ts";
import { RenderContext } from "./render.ts";
import { Line, LineSource } from "@bootstrapp/light/native/tui/lines.ts";

/** What holds the conversation a source draws: an app may replace the conversation (another folder opened), so a source asks each time. */
export abstract class ConversationHolder {
  abstract current(): Conversation;
}

export abstract class ModelSource extends LineSource {
  readonly holder: ConversationHolder;
  readonly ctx = new RenderContext();
  protected lines: Line[] = [];
  private model: ChatModel | null = null;
  private version = -1;
  private turns = -1;
  private width = -1;

  constructor(holder: ConversationHolder) {
    super();
    this.holder = holder;
  }

  /** Build the lines again on the next draw. */
  invalidate(): void {
    this.version = -1;
  }

  /** Whether the lines change on their own while shown (a running clock): built on every draw. */
  live(): boolean {
    return false;
  }

  override prepare(width: number): void {
    const conversation = this.holder.current();
    const model = conversation.model;
    const version = model.version.value;
    if (!this.live() && model === this.model && version === this.version && model.turns.length === this.turns && width === this.width) return;
    this.model = model;
    this.version = version;
    this.turns = model.turns.length;
    this.width = width;
    this.ctx.folder = conversation.folder;
    this.ctx.agent = conversation.agent.name();
    this.rebuild(model, width);
  }

  /** The lines for `model` at `width`, into `lines` or the source's own rows. */
  protected abstract rebuild(model: ChatModel, width: number): void;

  count(): number {
    return this.lines.length;
  }

  line(index: number, _width: number): Line {
    return index < this.lines.length ? this.lines[index] : new Line();
  }
}
