// This start's session: the conversation with the agent in the start's folder, and the
// SessionController over it (the agents, the trust, the store, the harness, the records), a new one
// each start. The real app's conversation takes the flags: --claude, --effort, --model, the fake
// CLI's --fake-fixture, and --ephemeral (Claude Code keeps nothing). Disposing ends the agent's process.
import { resolve } from "node:path";
import { Controller } from "@lightstart/light/controller/class.ts";
import app from "../app.ts";
import { Conversation } from "../conversation/conversation.ts";
import { SessionController } from "../host/session.ts";
import folder from "./folder.ts";
import run from "./run.ts";

export class SessionHolder extends Controller {
  /** This start's; set once the start made its conversation. */
  current!: SessionController;

  constructor() {
    super("session");
  }

  override connected(): Promise<void> | null {
    const where = folder.current.workspace.folder;
    const conversation = new Conversation(where);
    if (run.current.real) {
      conversation.executable = app.args.string("claude") ?? "";
      conversation.effort = app.args.string("effort") ?? "";
      const fixture = app.args.string("fake-fixture");
      if (fixture !== undefined) conversation.extraArgs.push("--fixture", resolve(fixture));
      if (app.args.flag("ephemeral")) conversation.extraArgs.push("--no-session-persistence");
      // --model names the model of a new session; without it, the models plugin's first.
      conversation.modelName = app.args.string("model") ?? "";
    }
    this.current = new SessionController(conversation, where);
    return null;
  }

  override disconnected(): Promise<void> | null {
    this.current.conversation.kill();
    return null;
  }
}

export default new SessionHolder();
