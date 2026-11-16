// The roles plugins play for one another: the code column, the chat column and the Tools tab, each
// a slot holding the role's base (does nothing) until the plugin playing it installs its own, and
// the base again when that plugin goes.
import { ChatTarget, ToolsTarget } from "../chat/roles.ts";
import { CodeTarget } from "../code/target.ts";

export class Roles {
  code: CodeTarget = new CodeTarget();
  chat: ChatTarget = new ChatTarget();
  tools: ToolsTarget = new ToolsTarget();

  /** The roles plugin `owner` played go back to their bases. */
  removeOwner(owner: string): void {
    if (this.code.owner === owner) this.code = new CodeTarget();
    if (this.chat.owner === owner) this.chat = new ChatTarget();
    if (this.tools.owner === owner) this.tools = new ToolsTarget();
  }
}
