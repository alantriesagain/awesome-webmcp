import { formatMoney } from "./money.mjs";

/** The receipt line for `amount`. */
export const receiptTotal = (amount) => "Receipt: " + formatMoney(amount, "USD");
