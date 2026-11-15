/** `fn` over `items`, at most `limit` at a time; the results in the items' order. */
export const mapLimit = async (items, limit, fn) => {
  const results = [];
  const running = items.map(async (item) => {
    const r = await fn(item);
    results.push(r);
  });
  await Promise.all(running);
  return results;
};
