// This start's screen (src/screen: the columns, the tabs, the band, the segments, the menus, the
// active column, the message, the focus), a new one each start over the start's kernel.
import { Controller } from "@lightstart/light/controller/class.ts";
import { ScreenController } from "../screen/screen.ts";
import kernel from "./kernel.ts";

export class ScreenHolder extends Controller {
  /** This start's. */
  current = new ScreenController(kernel.current, "chat");

  constructor() {
    super("screen");
  }

  override connected(): Promise<void> | null {
    this.current = new ScreenController(kernel.current, "chat");
    return null;
  }
}

export default new ScreenHolder();
