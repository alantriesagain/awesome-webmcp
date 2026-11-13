// Passes when formatMoney takes the options object and every caller passes its currency.
const at = process.cwd() + "/src/";
const { formatMoney } = await import(at + "money.mjs");
const money = (amount, currency, locale = "en-US", decimals = 2) => new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(amount);
const bad = [];
let got = "";
try { got = formatMoney(1234.5, { currency: "EUR", locale: "de-DE" }); } catch (e) { got = "threw " + e.message; }
if (got !== money(1234.5, "EUR", "de-DE")) bad.push("the options object gave " + JSON.stringify(got));
try { got = formatMoney(1234.5, { currency: "JPY", locale: "ja-JP", decimals: 0 }); } catch (e) { got = "threw " + e.message; }
if (got !== money(1234.5, "JPY", "ja-JP", 0)) bad.push("the decimals option gave " + JSON.stringify(got));
try { got = formatMoney(10); } catch (e) { got = "threw " + e.message; }
if (got !== money(10, "USD")) bad.push("the defaults gave " + JSON.stringify(got));
const callers = [
  ["invoice.mjs", "invoiceTotal", "EUR"], ["receipt.mjs", "receiptTotal", "USD"],
  ["payroll.mjs", "payrollTotal", "GBP"], ["report.mjs", "reportTotal", "JPY"],
  ["quote.mjs", "quoteTotal", "CHF"], ["summary.mjs", "summaryTotal", "CAD"],
];
for (const [file, name, currency] of callers) {
  let fn;
  try { fn = (await import(at + file))[name]; } catch (e) { bad.push(file + " did not load: " + e.message); continue; }
  if (typeof fn !== "function") { bad.push(file + " exports no " + name); continue; }
  let line;
  try { line = fn(1234.5); } catch (e) { line = "threw " + e.message; }
  const label = name.replace("Total", "");
  const wantLine = label.charAt(0).toUpperCase() + label.slice(1) + ": " + money(1234.5, currency);
  if (line !== wantLine) bad.push(file + " gave " + JSON.stringify(line) + ", want " + JSON.stringify(wantLine));
}
if (bad.length > 0) { console.log(bad.join("\n")); process.exit(1); }
console.log("ok");
