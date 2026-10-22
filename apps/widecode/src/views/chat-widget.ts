// The chat column's widget: the conversation with the agent and the composer under it
// (chat-pane.ts, with the completion strip and the walk through the folder's messages), and the
// agent's questions, plans and permissions with their answers (request-panel.ts). Once a plugin
// mounts it as a column it plays the host's chat role, takes the keys its own parts use (the open
// question or plan, the strip while it shows, the history) and follows the conversation; what a
// line from the composer does is the plugin's (`onLine`).
import { HostChat } from "../controllers/chat-host.ts";
import { Column } from "@widecode/screen/contributions.ts";
import { ChatTarget } from "@widecode/chat/roles.ts";
import { Host } from "../controllers/host.ts";
import { Binder } from "@light/kernel/actions.ts";
import { type KeyEvent } from "@bootstrapp/light/native/tui";
import { ChatPane } from "@widecode/chat/chat-pane.ts";

export class ChatWidget extends ChatTarget {
  readonly host: Host;
  readonly pane: ChatPane;
  /** What a line from the composer does when no question or plan takes it (null: nothing). */
  onLine: ((text: string) => void) | null = null;

  constructor(host: Host) {
    super();
    this.host = host;
    this.pane = new ChatPane(new HostChat(host));
  }

  /** Show it as plugin `owner`'s column named `title`, at `order`, `widthAt` cells wide, and play the chat role; what the owner added goes when it does. */
  mount(owner: string, title: string, order: number, widthAt: (cols: number) => number): void {
    const h = this.host;
    const pane = this.pane;
    h.screen.addColumn(owner, new Column("chat", title, order, pane, widthAt, 2, 1, pane.input, pane.view));
    this.owner = owner;
    this.composer = pane.composer;
    h.roles.chat = this;
    h.conversationChanged.add(owner, () => this.conversationChanged());
    h.folderOpened.add(owner, () => {
      pane.refresh();
      pane.showChat();
    });
    const bind = new Binder(h.kernel.actions, owner, "chat");
    // The agent's question or plan takes the keys it uses while it is open (first, so the strip's and the history's come before).
    const panel = (key: KeyEvent): boolean => pane.panel.active && pane.panel.key(key, pane.input.isEmpty());
    bind.add("chat.panel.up", ["up"], "", panel);
    bind.add("chat.panel.down", ["down"], "", panel);
    bind.add("chat.panel.escape", ["escape"], "", panel);
    bind.add("chat.panel.enter", ["enter"], "", panel);
    bind.add("chat.panel.previous", ["left"], "", panel);
    bind.add("chat.panel.next", ["right"], "", panel);
    bind.add("chat.panel.mark", ["char: "], "", panel);
    bind.add("chat.panel.choose", ["char:1", "char:2", "char:3", "char:4", "char:5", "char:6", "char:7", "char:8", "char:9"], "", panel);
    // ↑↓ on the composer's first and last lines walk the folder's messages; elsewhere they move between the lines. Added before the strip's, so the strip's ↑↓ come first while it shows.
    bind.add("chat.history.back", ["up"], "", (_key: KeyEvent) => pane.historyBack());
    bind.add("chat.history.forward", ["down"], "", (_key: KeyEvent) => pane.historyForward());
    // The completion strip, while it shows: Tab puts the highlighted one in; Enter on a command's name or value runs the command with it.
    bind.add("chat.strip.accept", ["tab"], "", (_key: KeyEvent) => pane.acceptSuggestion());
    bind.add("chat.strip.run", ["enter"], "", (_key: KeyEvent) => pane.runSuggestion());
    for (const spec of ["up", "down"]) bind.add("chat.strip." + spec, [spec], "", (_key: KeyEvent) => pane.moveSuggestion(spec === "up" ? -1 : 1));
    bind.add("chat.strip.hide", ["escape"], "", (_key: KeyEvent) => pane.hideSuggestions());
    // The composer's editing, in the "input" scope (after every other).
    pane.composer.addActions(new HostChat(h), owner);
  }

  override showChat(): void {
    this.pane.showChat();
  }

  /** A line from the composer: the open question or plan's answer, else the owner's. */
  override submit(text: string): void {
    const pane = this.pane;
    pane.strip.hide();
    if (pane.panel.active) {
      pane.panel.submitText(text);
      return;
    }
    const fn = this.onLine;
    if (fn !== null) fn(text);
  }

  /** A line the user typed: kept for ↑ unless it answers a question or plan, the walk ended, then submitted. */
  override typed(text: string): void {
    if (!this.pane.panel.active) this.host.remember(text);
    this.pane.leaveHistory();
    this.submit(text);
  }

  private conversationChanged(): void {
    const pane = this.pane;
    pane.refresh();
    pane.takeWithdrawn();
    const open = this.host.conversation.model.openRequests();
    const panel = pane.panel;
    const shown = panel.item;
    if (shown !== null && shown.state !== "open") panel.close();
    if (open.length > 0 && panel.item === null) {
      panel.agentName = this.host.conversation.agent.name();
      panel.open(open[0]);
      this.host.screen.focus("chat");
    }
  }
}
