import type { Leaf } from "./node.ts";
export function bumpOps(leaf: Leaf): void {
  leaf.n++;
  leaf.changed.emit(leaf.describe());
}
