import { Router } from 'express';
import { logMealEaten, planGrid, MEAL_SLOTS } from '../lib/kitchen.js';
import { wrap } from './wrap.js';

const num = (value) => {
  // An empty field means "not given", not zero. Number('') is 0, so without
  // this guard clearing a meal-plan cell submitted recipe_id 0 — a recipe that
  // cannot exist — instead of the null that tells setMealPlanCell to remove it.
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Recipes, inventory and the meal log (M4, docs/06).
 * Every mutation returns the partial it changed, never a full page.
 */
export function kitchenRouter(db) {
  const router = Router();

  const renderInventory = async (res, status = 200, error = null) => {
    const [rows, lowStock] = await Promise.all([db.listInventory(), db.lowStockItems()]);
    return res.status(status).render('partials/inventory-table', { rows, lowStock, error });
  };

  const renderRecipe = (res, recipe) => res.render('partials/recipe-card', { recipe, open: true });

  const renderPlan = async (res, trip) => {
    const [grid, recipes] = await Promise.all([planGrid(db, trip), db.listRecipes()]);
    res.render('partials/meal-plan', { trip, grid, recipes });
  };

  // ---- recipes ----

  router.get(
    '/recipes',
    wrap(async (req, res) => {
      const [recipeRows, recentMeals] = await Promise.all([db.listRecipes(), db.listMealLog(10)]);
      const recipes = await Promise.all(
        recipeRows.map(async (r) => ({ ...r, ingredients: await db.getRecipeIngredients(r.id) }))
      );
      res.render('recipes/index', { title: 'Recipes', recipes, recentMeals });
    })
  );

  router.post(
    '/recipes',
    wrap(async (req, res) => {
      const name = String(req.body.name || '').trim();
      if (!name) {
        res
          .status(400)
          .render('partials/error', { status: 400, message: 'A recipe needs a name.' });
        return;
      }
      const recipeId = await db.upsertRecipe(name);
      renderRecipe(res, await db.getRecipe(recipeId));
    })
  );

  router.get(
    '/recipes/:id',
    wrap(async (req, res) => {
      const recipe = await db.getRecipe(num(req.params.id));
      if (!recipe) {
        res.status(404).render('partials/error', { status: 404, message: 'Recipe not found.' });
        return;
      }
      renderRecipe(res, recipe);
    })
  );

  /**
   * Replace a recipe's ingredients. The editor posts the whole set as repeated
   * `ingredient` fields, so a removed row simply stops being submitted.
   */
  router.post(
    '/recipes/:id/ingredients',
    wrap(async (req, res) => {
      const recipe = await db.getRecipe(num(req.params.id));
      if (!recipe) {
        res.status(404).render('partials/error', { status: 404, message: 'Recipe not found.' });
        return;
      }
      // The editor is a textarea, so this arrives as one newline-separated blob;
      // accept commas too, and tolerate an array if the form ever becomes rows.
      const raw = req.body.ingredient;
      const names = [
        ...new Set(
          (Array.isArray(raw) ? raw : [raw])
            .filter(Boolean)
            .flatMap((chunk) => String(chunk).split(/[\n,]/))
            .map((n) => n.trim())
            .filter(Boolean)
        ),
      ];

      // Sequential: two spellings of one item must resolve to the same catalog
      // row, and racing the upserts would let both miss the conflict.
      const ingredients = [];
      for (const name of names) {
        const item = await db.getOrCreateItem(name, 'pantry');
        ingredients.push({ itemId: item.id, qty: 1 });
      }
      renderRecipe(res, await db.setRecipeIngredients(recipe.id, ingredients));
    })
  );

  router.delete(
    '/recipes/:id',
    wrap(async (req, res) => {
      await db.deleteRecipe(num(req.params.id));
      res.status(200).send('');
    })
  );

  // ---- inventory ----

  router.get(
    '/inventory',
    wrap(async (req, res) => {
      const [rows, lowStock, items] = await Promise.all([
        db.listInventory(),
        db.lowStockItems(),
        db.searchItems('', 200),
      ]);
      res.render('inventory/index', { title: 'Inventory', rows, lowStock, items });
    })
  );

  /** Start tracking an item, or overwrite its counts. */
  router.post(
    '/inventory',
    wrap(async (req, res) => {
      const name = String(req.body.item_name || '').trim();
      const qty = num(req.body.qty_on_hand);
      const threshold = num(req.body.low_threshold);
      if (!name || qty == null || qty < 0) {
        await renderInventory(res, 400, 'Pick an item and a quantity of zero or more.');
        return;
      }
      const item = await db.getOrCreateItem(name, req.body.category_key || 'pantry');
      await db.setInventory(item.id, {
        qtyOnHand: qty,
        unit: req.body.unit ? String(req.body.unit).trim() : null,
        lowThreshold: threshold == null || threshold < 0 ? 1 : threshold,
      });
      await renderInventory(res);
    })
  );

  /** Nudge a count up or down from the table (the +/- buttons). */
  router.patch(
    '/inventory/:itemId',
    wrap(async (req, res) => {
      const itemId = num(req.params.itemId);
      const current = await db.getInventory(itemId);
      if (!current) {
        res.status(404).render('partials/error', { status: 404, message: 'Item is not tracked.' });
        return;
      }
      const delta = num(req.body.delta);
      if (delta != null) {
        await db.adjustInventory(itemId, delta);
      } else {
        const qty = num(req.body.qty_on_hand);
        const threshold = num(req.body.low_threshold);
        await db.setInventory(itemId, {
          qtyOnHand: qty == null || qty < 0 ? current.qty_on_hand : qty,
          unit: req.body.unit ? String(req.body.unit).trim() : null,
          lowThreshold: threshold == null || threshold < 0 ? current.low_threshold : threshold,
        });
      }
      await renderInventory(res);
    })
  );

  router.delete(
    '/inventory/:itemId',
    wrap(async (req, res) => {
      await db.setInventory(num(req.params.itemId), { qtyOnHand: 0, lowThreshold: 1 });
      await renderInventory(res);
    })
  );

  // ---- the meal log: eating is what depletes stock ----

  router.post(
    '/meals/log',
    wrap(async (req, res) => {
      const recipeId = num(req.body.recipe_id);
      const freeText = String(req.body.free_text || '').trim() || null;
      if (recipeId == null && !freeText) {
        res.status(400).render('partials/error', {
          status: 400,
          message: 'Pick a recipe or describe the meal.',
        });
        return;
      }
      const result = await logMealEaten(db, {
        recipeId,
        freeText,
        eatenDate: req.body.eaten_date || null,
      });
      // Read after the decrements, so the "running low" list reflects the meal
      // that was just eaten.
      const [recentMeals, lowStock] = await Promise.all([db.listMealLog(10), db.lowStockItems()]);
      res.render('partials/meal-logged', { result, recentMeals, lowStock });
    })
  );

  // ---- meal plan grid over the trip period ----

  router.get(
    '/trips/:id/plan',
    wrap(async (req, res) => {
      const trip = await db.getTrip(num(req.params.id));
      if (!trip) {
        res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
        return;
      }
      await renderPlan(res, trip);
    })
  );

  router.post(
    '/trips/:id/plan',
    wrap(async (req, res) => {
      const trip = await db.getTrip(num(req.params.id));
      if (!trip) {
        res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
        return;
      }
      const day = String(req.body.day || '');
      const slot = String(req.body.slot || '');
      if (!day || !MEAL_SLOTS.includes(slot)) {
        res.status(400).render('partials/error', { status: 400, message: 'Unknown plan cell.' });
        return;
      }
      await db.setMealPlanCell(trip.id, day, slot, {
        recipeId: num(req.body.recipe_id),
        freeText: String(req.body.free_text || '').trim() || null,
      });
      await renderPlan(res, trip);
    })
  );

  return router;
}
