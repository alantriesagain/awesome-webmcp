import { formatMoney } from "./money.mjs";

/** The report line for `amount`. */
export const reportTotal = (amount) => "Report: " + formatMoney(amount, "JPY");
