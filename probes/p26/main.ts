// P26: P21 (which passes) plus merely importing node.ts, whose TInput also instantiates Emitter<string>.
import { Leaf } from "./leaf.ts";
import { TInput } from "../../packages/tdom/src/node.ts";
void TInput;
const l = new Leaf();
const got: string[] = [];
l.changed.listen((v) => got.push("c:" + v));
l.submitted.listen((v) => got.push("s:" + v));
l.go();
console.log(got.join(","));
