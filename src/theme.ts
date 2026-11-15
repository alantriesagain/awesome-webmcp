// widecode's look as its plugins get it: the process's palette (@lightstart/tui) and the spinner as JSON
// for the prelude (`widecode.theme`, themeJson). The core's views read the palette directly; the
// syntax colors are the tokenizers' own (@lightstart/highlight).
import { SPINNER, TICK_MS } from "@lightstart/light/native/tui/ticks.ts";
import { palette } from "@lightstart/tui/palette.ts";

/** The theme as plugins get it, `widecode.theme` without its spinner function: JSON text for the prelude. */
export const themeJson = (): string => {
  const marks: string[] = [];
  for (const [mark, color] of palette.markColors()) marks.push(JSON.stringify(mark) + ":" + JSON.stringify(color));
  const pairs = [
    ["dim", palette.dim],
    ["ok", palette.ok],
    ["bad", palette.bad],
    ["warn", palette.warn],
    ["think", palette.think],
    ["link", palette.link],
    ["code", palette.code],
    ["prompt", palette.promptFg],
    ["selected", palette.selectedBg],
    ["shown", palette.shownBg],
    ["fresh", palette.fresh],
    ["band", palette.bandBg],
  ];
  const fields = pairs.map((p) => JSON.stringify(p[0]) + ":" + JSON.stringify(p[1]));
  fields.push('"marks":{' + marks.join(",") + "}");
  fields.push('"frames":' + JSON.stringify(SPINNER));
  fields.push('"tick":' + String(TICK_MS));
  return "{" + fields.join(",") + "}";
};
