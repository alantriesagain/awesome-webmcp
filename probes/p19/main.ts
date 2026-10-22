// P19: an Emitter<string> field on a class, used through a type-only import in another module.
import { Holder } from "./holder.ts";
import { bump } from "./ops.ts";
const h = new Holder();
const got: string[] = [];
h.changed.listen((v) => got.push(v));
bump(h);
bump(h);
h.changed.emit("direct");
console.log(got.join(","), h.changed.size);
