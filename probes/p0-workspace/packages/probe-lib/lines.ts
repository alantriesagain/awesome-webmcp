import { Line } from "@lightstart/light/tdom/lines.ts";

export const two = (): Line[] => {
  const a = new Line();
  a.add("one", "");
  const b = new Line();
  b.add("two", "");
  return [a, b];
};
