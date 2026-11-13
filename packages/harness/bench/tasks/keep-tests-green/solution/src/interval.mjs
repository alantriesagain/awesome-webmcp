/** The seconds in `text`: a number and a unit (`30s`, `5m`, `2h`, `1d`), or several in a row. */
export const parseInterval = (text) => {
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  const any = m !== null && (m[1] !== undefined || m[2] !== undefined || m[3] !== undefined || m[4] !== undefined);
  if (!any) throw new Error("bad interval: " + text);
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
};
