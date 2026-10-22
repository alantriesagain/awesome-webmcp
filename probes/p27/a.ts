import { Emitter } from "../../packages/signals/src/emitter.ts";
export class A { readonly ev = new Emitter<string>(); }
