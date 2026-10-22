// P5 (part): a module in a sibling directory, imported by a relative .ts path.
export class Counter {
  n = 0;
  bump(): number {
    this.n++;
    return this.n;
  }
}
export const VERSION = "p5";
export function twice(x: number): number {
  return x * 2;
}
