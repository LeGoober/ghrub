# M1 — Data layer + the running list — checklist

**Spec refs:** `docs/03-milestones.md` (M1) · `docs/00-quick-decisions.md` ·
`docs/02-data-model.md` · `docs/06-routes-and-ui.md` · `docs/05-agent-runbook.md`
**Branch:** `feature/m1-data-list` → PR into `dev`
**DoD source:** "can create the 'next shop' trip, add ≥ 10 items across
categories, tick some bought, see subtotal vs budget update without full page
reloads. Seed import covered by a test. CI green."

---

## Deliverables

| # | Deliverable | Ref | Lands in | Prove it | Expected | Done |
|---|-------------|-----|----------|----------|----------|------|
| 1 | `better-sqlite3` added; Dockerfile builds it | docs/00 | `package.json`, `Dockerfile`, `.dockerignore` | `docker build -t ghrub:ci .` | image exports; `COPY docs/seed/grocery-history.json` succeeds | ☑ |
| 2 | `schema.sql` identical to data model | docs/02 | `src/db/schema.sql` | verification check #2 below | 11 tables + 2 indexes, byte-identical SQL | ☑ |
| 3 | Migration runner on boot (tables missing) | docs/05 | `src/db/repo.js` (`migrate`) | verification check #3 below | `0` (schema applied) | ☑ |
| 4 | All DB access via repo.js | docs/05 | `src/db/repo.js` | `grep -rn "better-sqlite3\|new Database\|\.prepare(" src scripts | grep -v src/db/repo.js` | no matches outside repo.js | ☑ |
| 5 | Idempotent seed, ZAR→cents ×100, headless default path | docs/02 | `scripts/seed.js` | `node scripts/seed.js && node scripts/seed.js` | identical counts both runs: categories 13, stores 3, items 100, trips 10, trip_items 212, recipes 16, recipe_ingredients 53 | ☑ |
| 6 | Trip CRUD + workspace + list routes (HTMX partials, never full reload) | docs/06 | `src/routes/trips.js`, `src/server.js`, `src/views/` | `npm test` (routes suite) | 9 route tests pass incl. `hx-swap-oob="true"` asserted on add-item and header PATCH | ☑ |
| 7 | Live budget bar: blend subtotal vs budget, per-category, amber/red | docs/06 | `src/db/repo.js` (`budgetForTrip`), `src/views/partials/budget-bar.ejs` | `npm test` (repo suite) | subtotal blends actual for bought, est otherwise; state `ok|near|over|unbudgeted` | ☑ |

## Routes delivered (docs/06)

| Route | Behaviour |
|-------|-----------|
| `GET /` | dashboard: next/active trip + quick create |
| `GET /trips` | history list |
| `POST /trips` | create → 302 to `/trips/:id` |
| `GET /trips/:id` | workspace: header, budget bar, category groups, type-ahead |
| `PATCH /trips/:id` | update name/dates/budget/status → header partial + OOB bar |
| `DELETE /trips/:id` | remove → 302 `/trips` |
| `POST /trips/:id/items` | add line → lists partial + OOB bar |
| `PATCH /trips/:id/items/:lineId` | tick bought / qty / est / actual → lists partial + OOB bar |
| `DELETE /trips/:id/items/:lineId` | remove line → lists partial + OOB bar |
| `GET /trips/:id/items/suggest?q=` | type-ahead `<ul>` from catalog |

## Verification commands (run and record)

```bash
npm run lint          # 0 errors, 0 warnings  → PASSED
npm run format        # All matched files use Prettier code style!  → PASSED
npm test              # 4 files, 22 tests, all passing  → PASSED
node scripts/seed.js  # seed complete: {categories:13, stores:3, items:100,
                      # trips:10, trip_items:212, recipes:16, recipe_ingredients:53}
node scripts/seed.js  # identical counts on second run (idempotent)  → PASSED
docker build -t ghrub:ci .  # builds to the end, image exported  → PASSED
```

**Check #2 — schema identity** (extracts only the first ```sql block in the doc, since
`docs/02-data-model.md` also contains reference-query snippets):

```bash
awk '/^```sql$/{n++; if(n==1) f=1; next} f && /^```$/{exit} f' docs/02-data-model.md | diff - src/db/schema.sql && echo identical
```

**Check #3 — migration on boot** (fresh in-memory DB; schema must be applied):

```bash
node --input-type=module -e "const {createDatabase}=await import('./src/db/repo.js'); const db=createDatabase(':memory:'); console.log(db.count('trip'))"
```

## Gotchas hit in M1 (see reports/README.md)

1. `.dockerignore` excluded `docs` → the uncommented `COPY docs/seed` failed;
   fixed by excluding `*.md` only and shipping the seed JSON explicitly.
2. Seed prices are whole ZAR → ×100 to cents (`toCents`), asserted in tests.
3. `trip` has no unique key → idempotency via `upsertTripByName` (name lookup),
   not a bare `ON CONFLICT`.
4. Docker Desktop (Windows) buildkit choked on the directory `COPY`; explicit
   file `COPY` builds green locally. CI on `ubuntu-latest` is authoritative.

## DoD statement (PR body)

> Implemented M1 per `docs/03-milestones.md`: schema + migration runner +
> repository (`src/db/repo.js`), idempotent seed (`scripts/seed.js`, covered by
> `test/seed.test.js`), trip CRUD + the running list with type-ahead, category
> groups, bought/actual ticking and a live budget bar (amber near / red over)
> — every mutation is an HTMX partial with the budget bar as an
> `hx-swap-oob` swap, no full-page reloads. Can create a trip, add items across
> categories, tick bought, and watch subtotal vs budget update without reloads.
> CI green locally: lint + format + 22 tests + idempotent seed + docker build.
