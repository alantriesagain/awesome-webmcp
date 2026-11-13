// Passes when the badge takes bonus points while gauges and progress bars stay capped.
const at = process.cwd() + "/src/report.mjs";
const { gaugeText, progressText, badgeText, metricLabel } = await import(at);
const cases = [
  ["gauge at the top", gaugeText(150), "100%"],
  ["gauge below the bottom", gaugeText(-20), "0%"],
  ["gauge rounds", gaugeText(42.24), "42.2%"],
  ["progress at the top", progressText(150), "100%"],
  ["progress rounds", progressText(42.6), "43%"],
  ["progress below the bottom", progressText(-1), "0%"],
  ["badge with bonus", badgeText(110), "110%"],
  ["badge at the bonus top", badgeText(120), "120%"],
  ["badge above the bonus top", badgeText(130), "120%"],
  ["badge below the bottom", badgeText(-5), "0%"],
  ["badge rounds", badgeText(42.26), "42.3%"],
  ["a label", metricLabel("api_requests"), "API requests"],
];
const bad = [];
for (const [name, got, want] of cases) {
  if (got !== want) bad.push(name + " gave " + JSON.stringify(got) + ", want " + JSON.stringify(want));
}
if (bad.length > 0) { console.log(bad.join("\n")); process.exit(1); }
console.log("ok");
