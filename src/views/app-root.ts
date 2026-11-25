// The root view: the shell the app's pieces build, drawn as the terminal's whole screen. Keys go
// to the shell; mounted passes the renderer to the controller, which does what the old entry did
// with it (focus, clipboard, resize, load, resume, a selftest).
import { type KeyEvent, type Renderer, View } from "@lightstart/light/native/tui";
import lightcode from "../controllers/lightcode.ts";

export default class AppRoot extends View {
  constructor() {
    super();
    this.box.flex = 1;
  }

  override render(): unknown {
    const w = lightcode.w;
    return w === null ? null : w.shell;
  }

  onKey(_renderer: Renderer, e: KeyEvent): boolean {
    const w = lightcode.w;
    if (w === null) return false;
    w.shell.handleKey(e);
    return true;
  }

  mounted(renderer: Renderer): void {
    lightcode.mounted(renderer);
  }
}
