import { formatMoney } from "./money.mjs";

/** The payroll line for `amount`. */
export const payrollTotal = (amount) => "Payroll: " + formatMoney(amount, "GBP");
