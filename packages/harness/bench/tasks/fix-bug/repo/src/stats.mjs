// Small statistics over lists of numbers.

/** The mean of `xs` (0 for none). */
export const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / (xs.length - 1));

/** The middle value of `xs` once sorted; the mean of the two middle ones for an even count. */
export const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** The largest minus the smallest. */
export const range = (xs) => (xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs));
