import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server.js';
import { createDatabase } from '../src/db/repo.js';
import { runSeed } from '../scripts/seed.js';
import {
  logMealEaten,
  applyBoughtToInventory,
  lowStockSuggestions,
  planDays,
} from '../src/lib/kitchen.js';

describe('recipes -> inventory loop (M4)', () => {
  let db;
  let app;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runSeed(db);
    app = createApp(db);
  });

  const stockRecipe = (name, qtyOnHand = 2, lowThreshold = 1) => {
    const recipe = db.listRecipes().find((r) => r.name.startsWith(name));
    for (const ing of db.getRecipeIngredients(recipe.id)) {
      db.setInventory(ing.item_id, { qtyOnHand, lowThreshold });
    }
    return db.getRecipe(recipe.id);
  };

  it('draws every ingredient down when a seeded recipe is logged as eaten', () => {
    const recipe = stockRecipe('Chicken Alfredo');
    const { decremented } = logMealEaten(db, { recipeId: recipe.id });

    expect(decremented).toHaveLength(recipe.ingredients.length);
    for (const ing of recipe.ingredients) {
      expect(db.getInventory(ing.item_id).qty_on_hand).toBe(1);
    }
    expect(db.count('meal_log')).toBe(1);
  });

  it('records a free-text meal but moves no stock', () => {
    stockRecipe('Chicken Alfredo');
    const before = db.listInventory().map((r) => r.qty_on_hand);

    const { recipe, decremented } = logMealEaten(db, { freeText: 'Leftovers' });

    expect(recipe).toBeNull();
    expect(decremented).toHaveLength(0);
    expect(db.listInventory().map((r) => r.qty_on_hand)).toEqual(before);
    expect(db.listMealLog()[0].free_text).toBe('Leftovers');
  });

  it('never lets stock go negative', () => {
    const recipe = stockRecipe('Chicken Alfredo', 0);
    logMealEaten(db, { recipeId: recipe.id });
    for (const ing of recipe.ingredients) {
      expect(db.getInventory(ing.item_id).qty_on_hand).toBe(0);
    }
  });

  it('surfaces an item that crosses its threshold on a new trip', async () => {
    const recipe = stockRecipe('Chicken Alfredo', 2, 1);
    expect(db.lowStockItems()).toHaveLength(0);

    logMealEaten(db, { recipeId: recipe.id });

    const low = db.lowStockItems().map((r) => r.item_name);
    expect(low.length).toBe(recipe.ingredients.length);

    const trip = db.createTrip({ name: 'Restock run' });
    const res = await request(app).get(`/trips/${trip.id}`);
    expect(res.text).toContain('Running low');
    for (const name of low) expect(res.text).toContain(name);
  });

  it('drops an item from Running low once it is on the list', () => {
    const recipe = stockRecipe('Chicken Alfredo', 1, 1);
    const trip = db.createTrip({ name: 'Restock run' });
    const [first] = recipe.ingredients;

    expect(lowStockSuggestions(db, trip.id).map((r) => r.name)).toContain(first.item_name);
    db.addTripItem(trip.id, { itemId: first.item_id, categoryKey: 'pantry' });
    expect(lowStockSuggestions(db, trip.id).map((r) => r.name)).not.toContain(first.item_name);
  });

  it('only counts tracked items as low, not the whole catalog', () => {
    expect(db.count('item')).toBeGreaterThan(50);
    expect(db.lowStockItems()).toHaveLength(0);
  });

  describe('buying restocks the kitchen', () => {
    let trip;
    let line;
    let itemId;

    beforeEach(() => {
      const item = db.getOrCreateItem('Pasta', 'bread_grains');
      itemId = item.id;
      db.setInventory(itemId, { qtyOnHand: 1, lowThreshold: 1 });
      trip = db.createTrip({ name: 'Restock run' });
      line = db.addTripItem(trip.id, { itemId, categoryKey: 'bread_grains', qty: 2 });
    });

    it('adds the quantity when a line is ticked bought', async () => {
      await request(app)
        .patch(`/trips/${trip.id}/items/${line.id}`)
        .type('form')
        .send({ bought: '1', qty: '2' });
      expect(db.getInventory(itemId).qty_on_hand).toBe(3);
    });

    it('does not restock again when an already-bought line is edited', async () => {
      const patch = (body) =>
        request(app).patch(`/trips/${trip.id}/items/${line.id}`).type('form').send(body);

      await patch({ bought: '1', qty: '2' });
      await patch({ bought: '1', qty: '2', actual: '30' });
      await patch({ bought: '1', qty: '2', actual: '31' });

      expect(db.getInventory(itemId).qty_on_hand).toBe(3); // not 5, not 7
    });

    it('takes the stock back off when a line is un-ticked', async () => {
      const patch = (body) =>
        request(app).patch(`/trips/${trip.id}/items/${line.id}`).type('form').send(body);

      await patch({ bought: '1', qty: '2' });
      await patch({ qty: '2' }); // checkbox absent => not bought
      expect(db.getInventory(itemId).qty_on_hand).toBe(1);
    });

    it('takes the stock back off when a bought line is deleted', async () => {
      await request(app)
        .patch(`/trips/${trip.id}/items/${line.id}`)
        .type('form')
        .send({ bought: '1', qty: '2' });
      expect(db.getInventory(itemId).qty_on_hand).toBe(3);

      await request(app).delete(`/trips/${trip.id}/items/${line.id}`);
      expect(db.getInventory(itemId).qty_on_hand).toBe(1);
    });

    it('leaves stock alone when an unbought line is deleted', async () => {
      await request(app).delete(`/trips/${trip.id}/items/${line.id}`);
      expect(db.getInventory(itemId).qty_on_hand).toBe(1);
    });
  });

  it('moves nothing when the bought flag did not actually change', () => {
    const item = db.getOrCreateItem('Pasta', 'bread_grains');
    db.setInventory(item.id, { qtyOnHand: 5 });
    expect(
      applyBoughtToInventory(db, { itemId: item.id, qty: 2, wasBought: 1, isBought: 1 })
    ).toBeNull();
    expect(db.getInventory(item.id).qty_on_hand).toBe(5);
  });

  describe('routes', () => {
    it('serves the recipes page with the seeded catalog', async () => {
      const res = await request(app).get('/recipes');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Chicken Alfredo');
    });

    it('creates a recipe and returns a card partial', async () => {
      const res = await request(app).post('/recipes').type('form').send({ name: 'Bunny chow' });
      expect(res.status).toBe(200);
      expect(res.text).toContain('Bunny chow');
      expect(res.text).not.toContain('<html');
      expect(db.listRecipes().some((r) => r.name === 'Bunny chow')).toBe(true);
    });

    it('rejects a nameless recipe', async () => {
      const res = await request(app).post('/recipes').type('form').send({ name: '  ' });
      expect(res.status).toBe(400);
    });

    it('replaces ingredients from the newline-separated editor', async () => {
      const id = db.upsertRecipe('Bunny chow');
      const res = await request(app)
        .post(`/recipes/${id}/ingredients`)
        .type('form')
        .send({ ingredient: 'Bread\nBeans\nCurry powder\nBeans' }); // duplicate ignored

      expect(res.status).toBe(200);
      const names = db.getRecipeIngredients(id).map((i) => i.item_name);
      expect(names.sort()).toEqual(['Beans', 'Bread', 'Curry powder']);

      // Re-posting a shorter list removes the dropped one.
      await request(app)
        .post(`/recipes/${id}/ingredients`)
        .type('form')
        .send({ ingredient: 'Bread' });
      expect(db.getRecipeIngredients(id).map((i) => i.item_name)).toEqual(['Bread']);
    });

    it('tracks an item and nudges its count from the table', async () => {
      const created = await request(app)
        .post('/inventory')
        .type('form')
        .send({ item_name: 'Eggs', qty_on_hand: '3', low_threshold: '2', unit: 'box' });
      expect(created.status).toBe(200);

      const eggs = db.getOrCreateItem('Eggs', 'dairy_eggs');
      expect(db.getInventory(eggs.id).qty_on_hand).toBe(3);

      await request(app).patch(`/inventory/${eggs.id}`).type('form').send({ delta: '-1' });
      expect(db.getInventory(eggs.id).qty_on_hand).toBe(2);
      expect(db.lowStockItems().map((r) => r.item_name)).toContain('Eggs');
    });

    it('rejects a negative or nameless inventory row', async () => {
      const res = await request(app)
        .post('/inventory')
        .type('form')
        .send({ item_name: 'Eggs', qty_on_hand: '-2' });
      expect(res.status).toBe(400);
      expect(res.text).toContain('zero or more');
    });

    it('404s an untracked item on PATCH', async () => {
      const res = await request(app).patch('/inventory/999999').type('form').send({ delta: '1' });
      expect(res.status).toBe(404);
    });

    it('logs a meal over HTTP and reports the drawdown', async () => {
      const recipe = stockRecipe('Chicken Alfredo');
      const res = await request(app)
        .post('/meals/log')
        .type('form')
        .send({ recipe_id: String(recipe.id) });

      expect(res.status).toBe(200);
      expect(res.text).toContain('Drew down');
      // The drawdown pushed every ingredient to its threshold, so the partial
      // also warns about what is now low.
      expect(res.text).toContain('low-banner');
      expect(res.text).toContain('Now running low');
      expect(res.text).not.toContain('<html');
    });

    it('rejects a meal log with neither a recipe nor a description', async () => {
      const res = await request(app).post('/meals/log').type('form').send({});
      expect(res.status).toBe(400);
    });

    it('renders and updates the meal-plan grid over the trip period', async () => {
      const trip = db.createTrip({
        name: 'Planned shop',
        start_date: '2026-08-10',
        end_date: '2026-08-16',
      });
      const recipe = db.listRecipes()[0];

      const grid = await request(app).get(`/trips/${trip.id}/plan`);
      expect(grid.status).toBe(200);
      expect((grid.text.match(/plan-day/g) || []).length).toBe(7);

      const set = await request(app)
        .post(`/trips/${trip.id}/plan`)
        .type('form')
        .send({ day: '2026-08-10', slot: 'dinner', recipe_id: String(recipe.id) });
      expect(set.status).toBe(200);
      expect(db.getMealPlan(trip.id)).toHaveLength(1);

      // Clearing the cell removes the row rather than leaving an empty one.
      await request(app)
        .post(`/trips/${trip.id}/plan`)
        .type('form')
        .send({ day: '2026-08-10', slot: 'dinner', recipe_id: '' });
      expect(db.getMealPlan(trip.id)).toHaveLength(0);
    });

    it('rejects an unknown meal-plan slot', async () => {
      const trip = db.createTrip({ name: 'Planned shop', start_date: '2026-08-10' });
      const res = await request(app)
        .post(`/trips/${trip.id}/plan`)
        .type('form')
        .send({ day: '2026-08-10', slot: 'brunch' });
      expect(res.status).toBe(400);
    });
  });

  describe('planDays', () => {
    it('spans start to end inclusive', () => {
      expect(planDays({ start_date: '2026-08-10', end_date: '2026-08-16' })).toHaveLength(7);
    });

    it('falls back to a week when there is no end date', () => {
      expect(planDays({ start_date: '2026-08-10', end_date: null })).toHaveLength(7);
    });

    it('is empty when the trip has no dates at all', () => {
      expect(planDays({ start_date: null, end_date: null, shop_date: null })).toHaveLength(0);
    });

    it('caps a runaway period', () => {
      expect(planDays({ start_date: '2026-01-01', end_date: '2027-01-01' })).toHaveLength(21);
    });
  });
});
