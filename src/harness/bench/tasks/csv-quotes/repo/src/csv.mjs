/** The rows of CSV text, each an array of its fields. */
export const parseCsv = (text) => {
  const rows = [];
  for (const line of text.split("\n")) {
    const fields = [];
    let field = "";
    let quoted = false;
    for (const c of line) {
      if (c === '"') quoted = !quoted;
      else if (c === "," && !quoted) {
        fields.push(field);
        field = "";
      } else field += c;
    }
    fields.push(field);
    rows.push(fields);
  }
  return rows;
};
