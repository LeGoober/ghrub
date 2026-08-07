/**
 * The eat → deplete → restock loop (M4).
 *
 * No SQL — everything goes through `repo.js` (docs/05). This module owns the
 * rules about *when* stock moves, which is the part that is easy to get wrong:
 *
 * - Logging a meal decrements each of its ingredients by the recipe quantity.
 * - Ticking a line **bought** restocks it; un-ticking takes it back off. Both
 *   fire only on the transition, so toggling a checkbox five times does not
 *   add five units.
 * - Stock never goes negative (enforced in `repo.adjustInventory`).
 */

export const MEAL_SLOTS = ['breakfast', 'lunch', 'lunch2', 'dinner', 'dessert'];

/**
 * Log a meal as eaten and decrement whatever it was made of.
 *
 * @returns {{ log: object, decremented: Array<{itemId:number,itemName:string,qty:number,remaining:number}> }}
 */
export async function logMealEaten(
  db,
  { recipeId = null, freeText = null, eatenDate = null } = {}
) {
  const recipe = recipeId ? await db.getRecipe(recipeId) : null;
  const log = await db.logMeal({ recipeId: recipe ? recipe.id : null, freeText, eatenDate });

  // Free-text meals are recorded but cannot move stock — ghrub does not know
  // what "leftovers" was made of.
  if (!recipe) return { log, recipe: null, decremented: [] };

  // Sequential, not Promise.all: two ingredients sharing an item must apply
  // their decrements in order, or the second read-modify-write clobbers the first.
  const decremented = [];
  for (const ingredient of recipe.ingredients) {
    const row = await db.adjustInventory(ingredient.item_id, -ingredient.qty);
    decremented.push({
      itemId: ingredient.item_id,
      itemName: ingredient.item_name,
      qty: ingredient.qty,
      remaining: row.qty_on_hand,
    });
  }

  return { log, recipe, decremented };
}

/**
 * Apply the stock effect of a line's bought flag changing.
 *
 * Called with the value *before* and *after* the edit so it only moves stock on
 * an actual transition — PATCHing a line's price while it is already ticked
 * must not restock it again.
 */
export function applyBoughtToInventory(db, { itemId, qty = 1, wasBought, isBought }) {
  if (wasBought === isBought) return null;
  return db.adjustInventory(itemId, isBought ? qty : -qty);
}

/**
 * Items at or below their low-water mark, shaped like the other habit buckets
 * so the trip workspace can render them with the same partial.
 */
export async function lowStockSuggestions(db, tripId) {
  const onList = new Set(tripId ? await db.itemIdsOnTrip(tripId) : []);
  return (await db.lowStockItems())
    .filter((row) => !onList.has(row.item_id))
    .map((row) => ({
      item_id: row.item_id,
      name: row.item_name,
      category_key: row.category_key,
      category_label: row.category_label,
      qty_on_hand: row.qty_on_hand,
      low_threshold: row.low_threshold,
      unit: row.unit,
    }));
}

/**
 * The day columns of a trip's meal-plan grid.
 *
 * Falls back to a week from the shop date when the trip has no period set, so
 * the grid is usable before the dates are filled in. Capped at 21 days — the
 * grid is a planning aid, not a calendar.
 */
export function planDays(trip, { max = 21 } = {}) {
  const start = trip.start_date || trip.shop_date;
  if (!start) return [];
  const from = Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(from)) return [];

  const end = trip.end_date ? Date.parse(`${trip.end_date}T00:00:00Z`) : NaN;
  const dayMs = 86400000;
  const span = Number.isFinite(end) ? Math.round((end - from) / dayMs) + 1 : 7;
  const days = [];
  for (let i = 0; i < Math.min(Math.max(span, 1), max); i += 1) {
    const d = new Date(from + i * dayMs);
    days.push({
      iso: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }),
    });
  }
  return days;
}

/** Index the stored cells as `${day}|${slot}` for O(1) lookup while rendering. */
export async function planGrid(db, trip) {
  const cells = new Map();
  for (const cell of await db.getMealPlan(trip.id)) {
    cells.set(`${cell.day}|${cell.slot}`, cell);
  }
  return { days: planDays(trip), slots: MEAL_SLOTS, cells };
}
