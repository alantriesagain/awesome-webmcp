import { invoiceTotal } from "./invoice.mjs";
import { payrollTotal } from "./payroll.mjs";
import { quoteTotal } from "./quote.mjs";
import { receiptTotal } from "./receipt.mjs";
import { reportTotal } from "./report.mjs";
import { summaryTotal } from "./summary.mjs";

for (const line of [invoiceTotal(1234.5), receiptTotal(1234.5), payrollTotal(1234.5), reportTotal(1234.5), quoteTotal(1234.5), summaryTotal(1234.5)]) console.log(line);
