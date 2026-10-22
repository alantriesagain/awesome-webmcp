import type { Leaf } from "./leaf.ts";
function notify(leaf: Leaf): void {
  const v = leaf.value();
  leaf.changed.emit(v);
}
export function poke(leaf: Leaf): void {
  leaf.lines[leaf.row] = leaf.lines[leaf.row] + "x";
  leaf.col++;
  notify(leaf);
  leaf.submitted.emit("s" + String(leaf.col));
}
