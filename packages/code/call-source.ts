// A tool call on a page of its own, for the code column: its line, where it stands and for how
// long (live while it runs), its input whole and its output (conversation/render.ts `callPage`). Built
// again when the conversation changes, and on each draw while the call runs (its clock).
import { palette } from "@light/ui/palette.ts";
import { span } from "@light/ui/duration.ts";
import { callMs, callState, findCall, RUNNING } from "@widecode/conversation/calls.ts";
import { ChatModel } from "@widecode/conversation/model.ts";
import { callPage } from "@widecode/conversation/render.ts";
import { Line } from "@bootstrapp/light/native/tui/lines.ts";
import { ConversationHolder, ModelSource } from "@widecode/conversation/model-source.ts";

export class CallSource extends ModelSource {
  /** The call's tool use id. */
  readonly id: string;

  constructor(holder: ConversationHolder, id: string) {
    super(holder);
    this.id = id;
  }

  /** Whether the call is still running (its page draws again as its clock moves). */
  running(): boolean {
    const item = findCall(this.holder.current().model, this.id);
    return item !== null && callState(item) === RUNNING;
  }

  override live(): boolean {
    return this.running();
  }

  /** The whole page while the call runs (its clock moves), else none of it. */
  override liveFrom(): number {
    return this.running() ? 0 : this.lines.length;
  }

  protected rebuild(model: ChatModel, width: number): void {
    const item = findCall(model, this.id);
    if (item === null) {
      const l = new Line();
      l.add("This call is not in the conversation any more.", palette.dim);
      this.lines = [l];
      return;
    }
    const state = callState(item);
    const ms = callMs(item, Date.now());
    this.lines = callPage(item, this.ctx, width, ms >= 0 ? state + " · " + span(ms) : state);
  }
}
