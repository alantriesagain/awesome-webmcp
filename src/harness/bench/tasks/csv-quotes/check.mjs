// Passes when parseCsv follows RFC 4180 on cases test.mjs does not have.
const { parseCsv } = await import(process.cwd() + "/src/csv.mjs");
const cases = [
  ["a,b\nc,d", [["a", "b"], ["c", "d"]]],
  ["a,b\n", [["a", "b"]]],
  ['x,"y,z"', [["x", "y,z"]]],
  ['"say ""hi""",2', [['say "hi"', "2"]]],
  ['"two\nlines",z\nnext,row', [["two\nlines", "z"], ["next", "row"]]],
  ['"",empty', [["", "empty"]]],
  ["a,,c", [["a", "", "c"]]],
  ['"a""b","c"\r\nd,e\r\n', [['a"b', "c"], ["d", "e"]]],
];
const bad = [];
for (const [input, want] of cases) {
  let got;
  try { got = parseCsv(input); } catch (e) { got = "threw " + e.message; }
  if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(JSON.stringify(input) + " gave " + JSON.stringify(got));
}
if (bad.length > 0) { console.log(bad.join("\n")); process.exit(1); }
console.log("ok");
