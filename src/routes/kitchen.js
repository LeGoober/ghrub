import { Router } from 'express';
import { logMealEaten, planGrid, MEAL_SLOTS } from '../lib/kitchen.js';

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Recipes, inventory and the meal log (M4, docs/06).
 * Every mutation returns the partial it changed, never a full page.
 */
export function kitchenRouter(db) {
  const router = Router();

  const renderInventory = (res, status = 200, error = null) =>
    res.status(status).render('partials/inventory-table', {
      rows: db.listInventory(),
      lowStock: db.lowStockItems(),
      error,
    });

  const renderRecipe = (res, recipe) => res.render('partials/recipe-card', { recipe, open: true });

  // ---- recipes ----

  router.get('/recipes', (req, res) => {
    res.render('recipes/index', {
      title: 'Recipes',
      recipes: db.listRecipes().map((r) => ({ ...r, ingredients: db.getRecipeIngredients(r.id) })),
      recentMeals: db.listMealLog(10),
    });
  });

  router.post('/recipes', (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) {
      res.status(400).render('partials/error', { status: 400, message: 'A recipe needs a name.' });
      return;
    }
    const recipeId = db.upsertRecipe(name);
    renderRecipe(res, db.getRecipe(recipeId));
  });

  router.get('/recipes/:id', (req, res) => {
    const recipe = db.getRecipe(num(req.params.id));
    if (!recipe) {
      res.status(404).render('partials/error', { status: 404, message: 'Recipe not found.' });
      return;
    }
    renderRecipe(res, recipe);
  });

  /**
   * Replace a recipe's ingredients. The editor posts the whole set as repeated
   * `ingredient` fields, so a removed row simply stops being submitted.
   */
  router.post('/recipes/:id/ingredients', (req, res) => {
    const recipe = db.getRecipe(num(req.params.id));
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

    const ingredients = names.map((name) => ({
      itemId: db.getOrCreateItem(name, 'pantry').id,
      qty: 1,
    }));
    renderRecipe(res, db.setRecipeIngredients(recipe.id, ingredients));
  });

  router.delete('/recipes/:id', (req, res) => {
    db.deleteRecipe(num(req.params.id));
    res.status(200).send('');
  });

  // ---- inventory ----

  router.get('/inventory', (req, res) => {
    res.render('inventory/index', {
      title: 'Inventory',
      rows: db.listInventory(),
      lowStock: db.lowStockItems(),
      items: db.searchItems('', 200),
    });
  });

  /** Start tracking an item, or overwrite its counts. */
  router.post('/inventory', (req, res) => {
    const name = String(req.body.item_name || '').trim();
    const qty = num(req.body.qty_on_hand);
    const threshold = num(req.body.low_threshold);
    if (!name || qty == null || qty < 0) {
      renderInventory(res, 400, 'Pick an item and a quantity of zero or more.');
      return;
    }
    const item = db.getOrCreateItem(name, req.body.category_key || 'pantry');
    db.setInventory(item.id, {
      qtyOnHand: qty,
      unit: req.body.unit ? String(req.body.unit).trim() : null,
      lowThreshold: threshold == null || threshold < 0 ? 1 : threshold,
    });
    renderInventory(res);
  });

  /** Nudge a count up or down from the table (the +/- buttons). */
  router.patch('/inventory/:itemId', (req, res) => {
    const itemId = num(req.params.itemId);
    if (!db.getInventory(itemId)) {
      res.status(404).render('partials/error', { status: 404, message: 'Item is not tracked.' });
      return;
    }
    const delta = num(req.body.delta);
    if (delta != null) {
      db.adjustInventory(itemId, delta);
    } else {
      const qty = num(req.body.qty_on_hand);
      const threshold = num(req.body.low_threshold);
      const current = db.getInventory(itemId);
      db.setInventory(itemId, {
        qtyOnHand: qty == null || qty < 0 ? current.qty_on_hand : qty,
        unit: req.body.unit ? String(req.body.unit).trim() : null,
        lowThreshold: threshold == null || threshold < 0 ? current.low_threshold : threshold,
      });
    }
    renderInventory(res);
  });

  router.delete('/inventory/:itemId', (req, res) => {
    db.setInventory(num(req.params.itemId), { qtyOnHand: 0, lowThreshold: 1 });
    renderInventory(res);
  });

  // ---- the meal log: eating is what depletes stock ----

  router.post('/meals/log', (req, res) => {
    const recipeId = num(req.body.recipe_id);
    const freeText = String(req.body.free_text || '').trim() || null;
    if (recipeId == null && !freeText) {
      res
        .status(400)
        .render('partials/error', { status: 400, message: 'Pick a recipe or describe the meal.' });
      return;
    }
    const result = logMealEaten(db, {
      recipeId,
      freeText,
      eatenDate: req.body.eaten_date || null,
    });
    res.render('partials/meal-logged', {
      result,
      recentMeals: db.listMealLog(10),
      lowStock: db.lowStockItems(),
    });
  });

  // ---- meal plan grid over the trip period ----

  router.get('/trips/:id/plan', (req, res) => {
    const trip = db.getTrip(num(req.params.id));
    if (!trip) {
      res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
      return;
    }
    res.render('partials/meal-plan', {
      trip,
      grid: planGrid(db, trip),
      recipes: db.listRecipes(),
    });
  });

  router.post('/trips/:id/plan', (req, res) => {
    const trip = db.getTrip(num(req.params.id));
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
    db.setMealPlanCell(trip.id, day, slot, {
      recipeId: num(req.body.recipe_id),
      freeText: String(req.body.free_text || '').trim() || null,
    });
    res.render('partials/meal-plan', {
      trip,
      grid: planGrid(db, trip),
      recipes: db.listRecipes(),
    });
  });

  return router;
}
