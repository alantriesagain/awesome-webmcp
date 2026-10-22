// P6: a class field typed `(() => void) | null`, arrays of functions, Set/Map of class instances.
class Binding {
  cb: (() => void) | null = null;
  fire(): string {
    if (this.cb === null) return "none";
    this.cb();
    return "fired";
  }
}
class Listener {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
let hits = 0;
const b = new Binding();
const out: string[] = [b.fire()];
b.cb = () => {
  hits++;
};
out.push(b.fire(), b.fire());
b.cb = null;
out.push(b.fire(), "hits=" + String(hits));

const fns: ((v: number) => void)[] = [];
let acc = 0;
fns.push((v) => { acc += v; });
fns.push((v) => { acc += v * 10; });
for (const f of fns.slice()) f(2);
out.push("acc=" + String(acc));

const set = new Set<Listener>();
const l1 = new Listener("one");
set.add(l1);
set.add(l1);
set.add(new Listener("two"));
const map = new Map<string, Listener>();
map.set("k", l1);
out.push("set=" + String(set.size), "map=" + String(map.get("k") === l1));
console.log(out.join(" | "));
