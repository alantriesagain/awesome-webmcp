// P9: abstract base with virtual dispatch through base-typed receivers, instanceof narrowing across a class
// union, parent/child cycles between class instances, and Array.isArray on a class|array union.
abstract class Node {
  parent: Container | null = null;
  abstract render(): string;
  depth(): number {
    let d = 0;
    let p = this.parent;
    while (p !== null) {
      d++;
      p = p.parent;
    }
    return d;
  }
}
class Text extends Node {
  text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  render(): string {
    return this.text;
  }
}
class Container extends Node {
  children: Node[] = [];
  tag: string;
  constructor(tag: string) {
    super();
    this.tag = tag;
  }
  append(n: Node): void {
    n.parent = this;
    this.children.push(n);
  }
  render(): string {
    return "<" + this.tag + ">" + this.children.map((c) => c.render()).join("") + "</" + this.tag + ">";
  }
}
class Live {
  fn: () => string;
  constructor(fn: () => string) {
    this.fn = fn;
  }
}
class Keyed {
  k: string;
  constructor(k: string) {
    this.k = k;
  }
}
type Value = string | Live | Keyed | Node | Value[];

function commit(v: Value): string {
  if (typeof v === "string") return "str:" + v;
  if (v instanceof Live) return "live:" + v.fn();
  if (v instanceof Keyed) return "key:" + v.k;
  if (v instanceof Node) return "node:" + v.render() + "@" + String(v.depth());
  return "[" + v.map((x) => commit(x)).join(" ") + "]";
}

const root = new Container("box");
const inner = new Container("text");
inner.append(new Text("hi"));
root.append(inner);
const vals: Value[] = ["a", new Live(() => "L"), new Keyed("k"), inner, [root, "b"]];
console.log(commit(vals));
const bases: Node[] = [root, inner, inner.children[0]];
console.log(bases.map((b) => b.render().length + ":" + String(b.depth())).join(","));
