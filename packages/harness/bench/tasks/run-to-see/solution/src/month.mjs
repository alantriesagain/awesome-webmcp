/** The number of days in `month` (1-based) of `year`. */
export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const iso = (d) => d.toISOString().slice(0, 10);

/** Every day of `month` (1-based) of `year`, as YYYY-MM-DD. */
export const eachDayOf = (year, month) => {
  const days = [];
  const end = new Date(Date.UTC(year, month - 1, daysInMonth(year, month)));
  for (let d = new Date(Date.UTC(year, month - 1, 1)); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(iso(d));
  }
  return days;
};
