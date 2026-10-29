import { Caret, Clip, DEFAULT_STYLE, Screen, TRoot, View, frames, html, layout, mount, paint, signal } from "@lightstart/light/native";
import { Controller } from "@lightstart/light/controller/class.ts";
import { Greeter, Keyed } from "@tui/probe-lib";
import { two } from "@tui/probe-lib/lines.ts";

class Counter extends Controller {
  readonly count = signal(1);

  constructor() {
    super("counter");
  }

  bump(): void {
    this.count.value = this.count.peek() + 1;
  }
}

class Hello extends View {
  readonly greeter: Greeter;
  readonly counter: Counter;

  constructor(greeter: Greeter, counter: Counter) {
    super();
    this.greeter = greeter;
    this.counter = counter;
  }

  override render(): unknown {
    return html`<div>${this.greeter.greet() + " " + String(this.counter.count.value)}</div>`;
  }
}

const W = 24;
const H = 2;
const counter = new Counter();
const root = new TRoot();
mount(new Hello(new Greeter("workspace"), counter), root);
const screen = (): string[] => {
  for (let i = 0; i < 3; i++) {
    frames.flush();
    layout(root, W, H, DEFAULT_STYLE);
  }
  const s = new Screen(W, H);
  paint(root, s, new Clip(0, 0, W, H), DEFAULT_STYLE, new Caret(), null);
  return s.text().split("\n").map((l) => l.trimEnd());
};
for (const l of screen()) console.log("| " + l);
counter.bump();
for (const l of screen()) console.log("| " + l);
console.log("lines " + two().map((l) => l.runs.map((r) => r.text).join("")).join(","));
const keyed = new Keyed<Greeter>();
keyed.put("a", new Greeter("a"));
keyed.put("b", new Greeter("b"));
keyed.put("a", new Greeter("a2"));
const found = keyed.get("a");
console.log("keyed " + keyed.values().map((g) => g.greet()).join(";") + " found " + (found === null ? "none" : found.name));
