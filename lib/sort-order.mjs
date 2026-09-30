/**
 * Plans the neighbour shifts needed so that `target` can occupy slot `to`
 * inside one ordering group while keeping every slot unique.
 *
 * Rules:
 * - The edited or newly inserted item always wins the requested slot.
 * - Moving an item up (or inserting a new one) pushes the occupants at
 *   `to`, `to + 1`, ... down by one until the first free slot, so a list
 *   1–6 where #5 becomes #1 turns the old 1–4 into 2–5 and leaves 6 alone.
 * - Moving an item down first closes the slot it leaves behind (items in
 *   `(from, to]` move up by one), so the item lands exactly on `to`.
 * - Existing gaps and untouched historical duplicates outside the affected
 *   chain are left as they are.
 *
 * @param {Array<{ id: string, order: number }>} siblings other items of the group (target excluded)
 * @param {{ from?: number | null, to: number, max: number }} move
 * @returns {Array<{ id: string, from: number, to: number }>} changed siblings only
 */
export function planSortOrderShift(siblings, { from = null, to, max }) {
  const items = siblings
    .map(item => ({ id: String(item.id), original: Number(item.order), order: Number(item.order) }))
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const movingDown = from !== null && from !== undefined && to > from;
  // Only close the vacated slot when nobody else shares it; otherwise the
  // shift would create a new duplicate on top of historical data.
  if (movingDown && !items.some(item => item.order === from)) {
    for (const item of items) if (item.order > from && item.order <= to) item.order -= 1;
  }

  let occupied = to;
  for (const item of items.filter(entry => entry.order >= to).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (item.order > occupied) break;
    item.order = occupied + 1;
    occupied = item.order;
  }

  const changes = items.filter(item => item.order !== item.original).map(item => ({ id: item.id, from: item.original, to: item.order }));
  if (changes.some(item => item.to > max)) {
    throw Object.assign(new Error(`排序已排到上限 ${max}，请先调小其他项目的排序后再试`), { statusCode: 400 });
  }
  return changes;
}
