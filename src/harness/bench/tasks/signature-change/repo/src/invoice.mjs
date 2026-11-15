import { formatMoney } from "./money.mjs";

/** The invoice line for `amount`. */
export const invoiceTotal = (amount) => "Invoice: " + formatMoney(amount, "EUR");
