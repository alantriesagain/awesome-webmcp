/** One line per product, its price in the settings' currency. */
export const renderCatalog = (items, settings) => {
  const money = new Intl.NumberFormat(settings.locale, { style: "currency", currency: settings.currency });
  return items.map((item) => item.name + ": " + money.format(item.price));
};
