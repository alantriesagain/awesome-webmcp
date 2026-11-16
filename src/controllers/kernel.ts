// This start's kernel: the commands, the actions, the keys, the settings and the plugins, a new one
// each start. The screen and the keymap are built on it, so they import this controller and start
// after it; disposing stops its plugins.
import { Controller } from "@lightstart/light/controller/class.ts";
import { Kernel } from "@lightstart/kernel/kernel.ts";

export class KernelHolder extends Controller {
  /** This start's. */
  current = new Kernel();

  constructor() {
    super("kernel");
  }

  override connected(): Promise<void> | null {
    this.current = new Kernel();
    return null;
  }

  override disconnected(): Promise<void> | null {
    this.current.stop();
    return null;
  }
}

export default new KernelHolder();
