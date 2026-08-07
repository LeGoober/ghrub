#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/db/repo.js';
import { toCents } from '../src/lib/money.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_JSON_PATH = path.join(__dirname, '..', 'docs', 'seed', 'grocery-history.json');

/**
 * Import docs/seed/grocery-history.json into the given database.
 * Idempotent: re-running must not duplicate rows (INSERT ... ON CONFLICT;
 * trips are keyed on name because the trip table has no unique constraint).
 * Returns final row counts, which the CLI prints and tests assert on.
 *
 * Everything runs sequentially inside one transaction: the rows reference each
 * other (a trip item needs its item, a recipe ingredient needs its recipe), and
 * a half-applied import is worse than none.
 */
export async function runSeed(db) {
  const data = JSON.parse(readFileSync(SEED_JSON_PATH, 'utf8'));
  await db.transaction(async () => {
    for (const [idx, c] of data.categories.entries()) {
      await db.upsertCategory(c.key, c.label, idx);
    }
    for (const storeName of data.stores) {
      await db.getOrCreateStore(storeName);
    }
    for (const trip of data.trips) {
      const tripId = await db.upsertTripByName({
        name: trip.name,
        start_date: trip.start_date ?? null,
        end_date: trip.end_date ?? null,
        shop_date: trip.shop_date ?? null,
        budget_cents: toCents(trip.budget),
        status: 'done',
      });
      for (const [idx, it] of trip.items.entries()) {
        await db.addTripItem(tripId, {
          itemName: it.name,
          categoryKey: it.category,
          estCents: toCents(it.est),
          actualCents: toCents(it.actual),
          bought: it.bought ? 1 : 0,
          qty: it.qty ?? 1,
          position: idx, // stable across re-runs
        });
      }
    }
    for (const recipe of data.recipes_seed) {
      const recipeId = await db.upsertRecipe(recipe.name);
      for (const ingredient of recipe.ingredients) {
        const item = await db.getOrCreateItem(ingredient, 'pantry');
        await db.upsertRecipeIngredient(recipeId, item.id, 1);
      }
    }
  });

  return {
    categories: await db.count('category'),
    stores: await db.count('store'),
    items: await db.count('item'),
    trips: await db.count('trip'),
    trip_items: await db.count('trip_item'),
    recipes: await db.count('recipe'),
    recipe_ingredients: await db.count('recipe_ingredient'),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const db = await createDatabase(); // DATABASE_URL; migrates on connect if needed
  try {
    const counts = await runSeed(db);
    console.log('seed complete:', counts);
  } finally {
    await db.close();
  }
}
