import { formatMoney } from "./money.mjs";

/** The summary line for `amount`. */
export const summaryTotal = (amount) => "Summary: " + formatMoney(amount, { currency: "CAD" });
