// This start's keymaps (src/host/keymaps.ts: the user's keys.json, the keymap in use, the ones the
// plugins brought), a new one each start over the start's kernel.
import { Controller } from "@lightstart/light/controller/class.ts";
import { KeymapController } from "../host/keymaps.ts";
import kernel from "./kernel.ts";

export class KeymapHolder extends Controller {
  /** This start's. */
  current = new KeymapController(kernel.current);

  constructor() {
    super("keymap");
  }

  override connected(): Promise<void> | null {
    this.current = new KeymapController(kernel.current);
    return null;
  }
}

export default new KeymapHolder();
