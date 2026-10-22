// P27: the same generic specialization Emitter<string> instantiated in two modules.
import { A } from "./a.ts";
import { B } from "./b.ts";
const got: string[] = [];
const a = new A();
const b = new B();
a.ev.listen((v) => got.push("a:" + v));
b.ev.listen((v) => got.push("b:" + v));
try { a.ev.emit("1"); } catch (e) { got.push("a threw " + (e instanceof Error ? e.message : "?")); }
try { b.ev.emit("2"); } catch (e) { got.push("b threw " + (e instanceof Error ? e.message : "?")); }
console.log(got.join(","));
