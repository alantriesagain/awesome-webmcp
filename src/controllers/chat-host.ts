// widecode's host as the chat's views see it (src/chat's ChatHost): each answer the host's own of
// the moment.
import { ChatHost } from "../chat/host.ts";
import { ChatTarget, ToolsTarget } from "../chat/roles.ts";
import { CodeTarget } from "../code/target.ts";
import { Conversation } from "../conversation/conversation.ts";
import { PromptHistory } from "../conversation/history.ts";
import { Kernel } from "@lightstart/kernel/kernel.ts";
import { ScreenController } from "../screen/screen.ts";
import { spawn } from "node:child_process";
import { Host } from "./host.ts";

export class HostChat extends ChatHost {
  readonly host: Host;

  constructor(host: Host) {
    super();
    this.host = host;
  }

  override current(): Conversation {
    return this.host.conversation;
  }

  override screen(): ScreenController {
    return this.host.screen;
  }

  override kernel(): Kernel {
    return this.host.kernel;
  }

  override chat(): ChatTarget {
    return this.host.roles.chat;
  }

  override tools(): ToolsTarget {
    return this.host.roles.tools;
  }

  override code(): CodeTarget {
    return this.host.roles.code;
  }

  override paths(): string[] {
    return this.host.folder.paths();
  }

  override history(): PromptHistory {
    return this.host.session.history;
  }

  override openPath(path: string): void {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", path] : [path];
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    } catch {
      // The image does not open: nothing to say about it.
    }
  }
}
