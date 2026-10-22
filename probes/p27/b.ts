import { Emitter } from "../../packages/signals/src/emitter.ts";
export class B { readonly ev = new Emitter<string>(); }
