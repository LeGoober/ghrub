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
 */
export function runSeed(db) {
  const data = JSON.parse(readFileSync(SEED_JSON_PATH, 'utf8'));
  const tx = db.transaction(() => {
    data.categories.forEach((c, idx) => db.upsertCategory(c.key, c.label, idx));
    for (const storeName of data.stores) {
      db.getOrCreateStore(storeName);
    }
    for (const trip of data.trips) {
      const tripId = db.upsertTripByName({
        name: trip.name,
        start_date: trip.start_date ?? null,
        end_date: trip.end_date ?? null,
        shop_date: trip.shop_date ?? null,
        budget_cents: toCents(trip.budget),
        status: 'done',
      });
      trip.items.forEach((it, idx) => {
        db.addTripItem(tripId, {
          itemName: it.name,
          categoryKey: it.category,
          estCents: toCents(it.est),
          actualCents: toCents(it.actual),
          bought: it.bought ? 1 : 0,
          qty: it.qty ?? 1,
          position: idx, // stable across re-runs
        });
      });
    }
    for (const recipe of data.recipes_seed) {
      const recipeId = db.upsertRecipe(recipe.name);
      for (const ingredient of recipe.ingredients) {
        const item = db.getOrCreateItem(ingredient, 'pantry');
        db.upsertRecipeIngredient(recipeId, item.id, 1);
      }
    }
  });
  tx();

  return {
    categories: db.count('category'),
    stores: db.count('store'),
    items: db.count('item'),
    trips: db.count('trip'),
    trip_items: db.count('trip_item'),
    recipes: db.count('recipe'),
    recipe_ingredients: db.count('recipe_ingredient'),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const db = createDatabase(); // defaults to ./data/ghrub.db, mkdir -p handled inside
  try {
    const counts = runSeed(db);
    console.log('seed complete:', counts);
  } finally {
    db.close();
  }
}
