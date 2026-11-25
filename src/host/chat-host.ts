// lightcode's host as the chat's views see it (src/chat's ChatHost): each answer the host's own of
// the moment, over the controllers that hold it.
import { ChatHost } from "../chat/host.ts";
import { ChatTarget, ToolsTarget } from "../chat/roles.ts";
import { CodeTarget } from "../code/target.ts";
import { Conversation } from "../conversation/conversation.ts";
import { PromptHistory } from "../conversation/history.ts";
import { Kernel } from "@lightstart/kernel/kernel.ts";
import { ScreenController } from "../screen/screen.ts";
import { FolderController } from "@lightstart/workspace/folder.ts";
import { spawn } from "node:child_process";
import { Roles } from "./roles.ts";
import { SessionController } from "./session.ts";

export class HostChat extends ChatHost {
  readonly session: SessionController;
  readonly screenController: ScreenController;
  readonly kernelController: Kernel;
  readonly roles: Roles;
  readonly folder: FolderController;

  constructor(session: SessionController, screen: ScreenController, kernel: Kernel, roles: Roles, folder: FolderController) {
    super();
    this.session = session;
    this.screenController = screen;
    this.kernelController = kernel;
    this.roles = roles;
    this.folder = folder;
  }

  override current(): Conversation {
    return this.session.conversation;
  }

  override screen(): ScreenController {
    return this.screenController;
  }

  override kernel(): Kernel {
    return this.kernelController;
  }

  override chat(): ChatTarget {
    return this.roles.chat;
  }

  override tools(): ToolsTarget {
    return this.roles.tools;
  }

  override code(): CodeTarget {
    return this.roles.code;
  }

  override paths(): string[] {
    return this.folder.paths();
  }

  override history(): PromptHistory {
    return this.session.history;
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
