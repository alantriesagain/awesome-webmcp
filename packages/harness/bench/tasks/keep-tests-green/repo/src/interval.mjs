/** The seconds in `text`, a number and a unit: `30s`, `5m`, `2h`. */
export const parseInterval = (text) => {
  const m = /^(\d+)([smh])$/.exec(text);
  if (m === null) throw new Error("bad interval: " + text);
  const n = Number(m[1]);
  const unit = m[2];
  return n * (unit === "s" ? 1 : unit === "m" ? 60 : 3600);
};
