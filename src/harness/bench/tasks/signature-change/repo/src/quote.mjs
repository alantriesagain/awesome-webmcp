import { formatMoney } from "./money.mjs";

/** The quote line for `amount`. */
export const quoteTotal = (amount) => "Quote: " + formatMoney(amount, "CHF");
