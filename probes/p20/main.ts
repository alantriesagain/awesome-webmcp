// P20: Emitter<string> field on a subclass of an abstract base, used via a type-only import from a
// module the class module imports at runtime (node.ts -> ops.ts -> type node.ts).
import { Leaf } from "./node.ts";
const l = new Leaf();
const got: string[] = [];
l.changed.listen((v) => got.push(v));
l.bump();
l.bump();
console.log(got.join(","));
