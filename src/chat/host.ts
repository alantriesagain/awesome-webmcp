// What the chat's views need of the app that mounts them: the conversation of the moment (a
// ConversationHolder), the screen, the kernel's commands and actions, the roles, the folder's
// files for the @ completion, and the folder's message history. An app subclasses it over its own
// host; each is a method since an app may replace what it answers (another folder opened, a
// role's plugin reloaded).
import { ConversationHolder } from "../conversation/model-source.ts";
import { PromptHistory } from "../conversation/history.ts";
import { CodeTarget } from "../code/target.ts";
import { Kernel } from "@light/kernel/kernel.ts";
import { ScreenController } from "../screen/screen.ts";
import { ChatTarget, ToolsTarget } from "./roles.ts";

export abstract class ChatHost extends ConversationHolder {
  abstract screen(): ScreenController;
  abstract kernel(): Kernel;
  abstract chat(): ChatTarget;
  abstract tools(): ToolsTarget;
  abstract code(): CodeTarget;
  /** The folder's files, folder-relative. */
  abstract paths(): string[];
  abstract history(): PromptHistory;
  /** Open a file with the system's viewer (a prompt's "[Image #N]" chip pressed). */
  abstract openPath(path: string): void;
}
