// P3: a class field holding a discriminated union of records that reference class instances (ChildPart.state).
class Run {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}
class Part {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}
type EmptyState = { kind: "empty" };
type TextState = { kind: "text"; node: Run; text: string };
type ItemsState = { kind: "items"; parts: Part[]; keys: string[] | null };
type State = EmptyState | TextState | ItemsState;

class Holder {
  state: State = { kind: "empty" };
  describe(): string {
    const s = this.state;
    switch (s.kind) {
      case "empty":
        return "empty";
      case "text":
        return "text(" + s.node.text + "/" + s.text + ")";
      case "items":
        return "items(" + s.parts.map((p) => String(p.id)).join("+") + (s.keys === null ? ",nokeys" : "," + s.keys.join("")) + ")";
    }
  }
}

const h = new Holder();
const out: string[] = [h.describe()];
const run = new Run("hello");
h.state = { kind: "text", node: run, text: "hello" };
out.push(h.describe());
if (h.state.kind === "text") {
  h.state.node.text = "changed";
  out.push("same node: " + String(h.state.node === run));
}
h.state = { kind: "items", parts: [new Part(1), new Part(2)], keys: null };
out.push(h.describe());
h.state = { kind: "items", parts: [new Part(3)], keys: ["a", "b"] };
if (h.state.kind === "items") h.state.parts.push(new Part(4));
out.push(h.describe());
h.state = { kind: "empty" };
out.push(h.describe());
console.log(out.join(" | "));
