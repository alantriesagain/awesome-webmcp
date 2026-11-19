// This start's Host: the facade the plugins' api and the views are given, over the start's folder,
// session, kernel, screen and keymaps (the controllers it imports, so it starts after them).
import { Controller } from "@lightstart/light/controller/class.ts";
import { Host } from "../host/host.ts";
import folder from "./folder.ts";
import kernel from "./kernel.ts";
import keymap from "./keymap.ts";
import screen from "./screen.ts";
import session from "./session.ts";
import approval from "./approval.ts";

export class HostHolder extends Controller {
  /** This start's; set once the start made it. */
  current!: Host;

  constructor() {
    super("host");
  }

  override connected(): Promise<void> | null {
    this.current = new Host(folder.current, session.current, kernel.current, screen.current, keymap.current, approval.current);
    return null;
  }
}

export default new HostHolder();
