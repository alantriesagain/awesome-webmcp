/** `amount` as money, options giving the currency, locale and decimals. */
export const formatMoney = (amount, options = {}) => {
  const currency = options.currency ?? "USD";
  const locale = options.locale ?? "en-US";
  const decimals = options.decimals ?? 2;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
};
