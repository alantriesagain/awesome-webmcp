/** `amount` as money in `currency`. */
export const formatMoney = (amount, currency) => {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
};
