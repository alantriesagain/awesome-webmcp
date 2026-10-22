// P21: two Emitter<string> fields on a subclass, emitted from a helper in another module.
import { Leaf } from "./leaf.ts";
const l = new Leaf();
const got: string[] = [];
l.changed.listen((v) => got.push("c:" + v));
l.submitted.listen((v) => got.push("s:" + v));
l.go();
l.go();
console.log(got.join(","));
