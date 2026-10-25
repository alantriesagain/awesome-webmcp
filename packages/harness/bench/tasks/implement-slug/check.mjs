// Passes when slugify follows README.md on cases the agent did not see.
const { slugify } = await import(process.cwd() + "/src/slug.mjs");
const cases = [
  ["  Héllo, World!  ", "hello-world"], ["Crème Brûlée 2026", "creme-brulee-2026"], ["--A--B--", "a-b"],
  ["Año nuevo", "ano-nuevo"], ["!!!", "n-a"], ["", "n-a"], ["already-a-slug", "already-a-slug"], ["Ünïcödé  ünder_score", "unicode-under-score"],
];
const bad = [];
for (const [input, want] of cases) {
  let got;
  try { got = slugify(input); } catch (e) { got = "threw " + e.message; }
  if (got !== want) bad.push(JSON.stringify(input) + " gave " + JSON.stringify(got) + ", want " + JSON.stringify(want));
}
if (bad.length > 0) { console.log(bad.join("\n")); process.exit(1); }
console.log("ok");
