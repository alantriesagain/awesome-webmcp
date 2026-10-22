import type { Holder } from "./holder.ts";
export function bump(h: Holder): void {
  h.n++;
  h.changed.emit(h.value());
}
