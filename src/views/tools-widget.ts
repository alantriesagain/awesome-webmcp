// The Tools tab's role player: the plugin-facing widget mounting the tab (src/chat's ToolsPanel)
// on the host and playing the ToolsTarget role for the other plugins.
import { HostChat } from "../host/chat-host.ts";
import { ToolsTarget } from "../chat/roles.ts";
import { Host } from "../host/host.ts";
import { Binder } from "@lightstart/kernel/actions.ts";
import { type KeyEvent } from "@lightstart/light/native/tui";
import { CALL, ToolsPanel } from "../chat/tools-pane.ts";

export class ToolsWidget extends ToolsTarget {
  readonly host: Host;
  panel: ToolsPanel | null = null;

  constructor(host: Host) {
    super();
    this.host = host;
  }

  /** Add the Tools tab as plugin `owner`'s, titled `title` at `order` in the tools column, and play the tools role. */
  mount(owner: string, title: string, order: number): void {
    const h = this.host;
    const panel = new ToolsPanel(new HostChat(h), title, order);
    this.panel = panel;
    this.owner = owner;
    h.screen.addPanel(owner, panel);
    h.roles.tools = this;
    h.folderOpened.add(owner, () => {
      panel.source.selected = -1;
      panel.source.invalidate();
      panel.view.follow = true;
      panel.view.refresh();
    });
    const bind = new Binder(h.kernel.actions, owner, panel.id);
    bind.add("calls.up", ["up"], "shows the call", (_key: KeyEvent) => this.step(-1));
    bind.add("calls.down", ["down"], "shows the call", (_key: KeyEvent) => this.step(1));
    bind.add("calls.open", ["enter"], "shows the call", (_key: KeyEvent) => {
      panel.press(panel.source.selected, 0);
      return true;
    });
  }

  /** Select the next (`by` 1) or previous (-1) call. */
  private step(by: number): boolean {
    const panel = this.panel;
    if (panel === null) return false;
    const s = panel.source;
    s.prepare(panel.view.cols);
    let at = (s.selected < 0 ? (by > 0 ? -1 : s.rows.length) : s.selected) + by;
    while (at >= 0 && at < s.rows.length && s.rows[at].kind !== CALL) at += by;
    if (at < 0 || at >= s.rows.length) return true;
    panel.select(at, false);
    return true;
  }

  override reveal(id: string): void {
    const panel = this.panel;
    if (panel === null) return;
    const h = this.host;
    h.screen.setShown(panel.id);
    const s = panel.source;
    s.prepare(panel.view.cols);
    const at = s.rowOf(id);
    if (at < 0) return;
    panel.select(at, true);
  }
}
