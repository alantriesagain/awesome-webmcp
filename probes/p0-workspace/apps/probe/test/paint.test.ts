import { readFileSync } from "node:fs";
import { Caret, Clip, DEFAULT_STYLE, Screen, TRoot, View, frames, html, layout, mount, paint } from "@bootstrapp/light/native";

class Box extends View {
  override render(): unknown {
    return html`<div>${readFileSync("test/fixtures/x.txt", "utf8").trim()}</div>`;
  }
}

const root = new TRoot();
mount(new Box(), root);
for (let i = 0; i < 3; i++) {
  frames.flush();
  layout(root, 20, 1, DEFAULT_STYLE);
}
const s = new Screen(20, 1);
paint(root, s, new Clip(0, 0, 20, 1), DEFAULT_STYLE, new Caret(), null);
console.log("| " + s.text().trimEnd());
