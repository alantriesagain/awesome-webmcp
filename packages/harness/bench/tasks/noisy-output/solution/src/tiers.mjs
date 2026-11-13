/** The loyalty tier a points total belongs to. */
export const tierFor = (points) => {
  if (points < 0) return "invalid";
  if (points < 500) return "bronze";
  if (points < 1500) return "silver";
  if (points < 3000) return "gold";
  return "platinum";
};
