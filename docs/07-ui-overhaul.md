# 07 — UI overhaul (v0.3)

ghrub is used as an **installed home-screen app on a phone**, one-handed, often
in a shop aisle. This spec replaces the M5 visual layer with one designed for
that, and fixes the functional problems a walkthrough of production turned up.

## 1. What the walkthrough showed (production, iPhone 16 viewport, 2026-10-06)

| # | Where | Problem | Kind |
|---|-------|---------|------|
| F1 | Trip → Add item | **Category dropdown is empty.** Production's Neon database was never seeded, so there are no categories; every item insert fails the foreign key | Bug |
| F2 | Trip → Add item, Kitchen → Track | Submitting "GG" or "Eggs, 12, carton" resets the form and **nothing appears**: the 500 from F1 is discarded silently | Bug |
| F3 | Everywhere | Labels and helper text are ~10px; inputs barely contrast with the card; everything has the same weight, so nothing reads as the primary action | Design |
| F4 | Home, Trips | The **New trip form dominates** both screens: 6 fields shown permanently, empty dates printed as `yyyy/mm/dd` | Design |
| F5 | Trip | **Four empty suggestion cards** ("Your regulars", "New this list", "Often forgotten", "Running low") push the list below the fold | Design |
| F6 | Trip | The trip's own settings (name, three dates, budget, store, status) sit above the list as an always-open form | Design |
| F7 | Trip → Meal plan | A 14 × 5 grid of tiny selects; only 2.5 columns fit, the rest scroll sideways | Design |
| F8 | Kitchen | The "Track an item" form takes the screen; the list is an empty-state line at the bottom | Design |
| F9 | Spend | Charts render empty axes with one trip; the trip table squeezes the name into two lines | Design |
| F10 | Install | `apple-touch-icon` is an SVG, which iOS ignores, so the home-screen icon is a screenshot | Bug |
| F11 | Every first open | Render's free plan sleeps after 15 min idle; the home-screen app shows a blank white screen for ~30–50s | Ops |

## 2. Design system

**Direction:** a calm "fresh market" look. Light warm paper by default and a
true dark mode, one deep green brand colour, and amber/red reserved for budget
state. It should feel like a native iOS/Android app, not a web form.

- **Type:** the system font stack (SF Pro on iPhone, Roboto on Android), so it
  reads as native and costs no download. The scale is 13 / 15 / 17 (body) / 20
  / 24 / 32. Inputs are 17px, which also stops iOS zooming on focus. Labels
  are 14px semibold, never below 13px.
- **Space:** a 4px base (4, 8, 12, 16, 20, 24, 32), with 16px page gutters and
  safe-area insets honoured on every edge.
- **Surfaces:** page → card (radius 18, hairline border, soft shadow) → well.
  Inputs get a filled background, distinct from the card in both themes.
- **Targets:** 44px minimum, and 48px for form controls and primary buttons.
- **Motion:** 150–250ms ease-out. `prefers-reduced-motion` turns it off.

### Components
`app-bar` (large title, optional back and action) · `tabbar` (5 tabs,
translucent, safe-area aware) · `card` · `list` / `row` (title, meta, trailing
value) · `field` · `segmented` control · `chip` · `progress` · `sheet` (a
native `<dialog>` that slides up from the bottom) · `stepper` (− value +) ·
`empty` state · `toast` · `pill` (status).

## 3. Screens

### Home
A greeting and today's date. A **Next shop** hero card: name, shop day
("in 3 days" / "today"), budget progress, bought/listed count, and **Open
list**. Quick actions: Scan receipt · New trip · Kitchen · Prices. Running-low
chips. **New trip opens a bottom sheet**, with dates pre-filled (starts and
shop day today, lasts 14 days) so `yyyy/mm/dd` is never shown.

### Trips
Trip cards with a status pill, date, item count and a mini budget bar. **New
trip** sits in the app bar and opens the same sheet. Delete moves into the
trip's settings sheet (no destructive button on a list row).

### Trip workspace (the main screen)
1. App bar: back, trip name, status pill, **⋯** for a settings sheet (name,
   dates, budget, store, delete).
2. Sticky budget summary: spent / budget, a progress bar, "4 of 12 bought".
3. **Status** segmented control: Planning · Shopping · Done.
4. Add bar: one input and **Add**. Category and estimate sit behind "More"
   (category defaults to Auto).
5. The list, grouped by category. Each line is one 56px row: tick, name, qty,
   price. Tapping the row opens its qty / estimate / paid editor in place.
6. **Suggestions**: one card, only the buckets that have something, each a
   horizontally scrolling chip row. With nothing to suggest it collapses to
   one line.
7. **Where to shop**: one row per store with its total and coverage; the
   cheapest is highlighted.
8. **Meal plan**: collapsed by default; one row per day showing the planned
   meals; expanding a day shows a select per slot, full width.

### Scan
The camera is the primary action, the gallery secondary; the review uses the
new rows and fields.

### Kitchen (inventory)
A segmented control for Inventory · Recipes. **Track item** opens a sheet. Each
row has the item, what's on hand with its unit, a low badge, and a − / +
stepper.

### Recipes
**Add recipe** opens a sheet. A "Log a meal" card. Recipe cards with
**Ate this** and an ingredient editor.

### Spend
Hero stats, then charts only once there are ≥ 2 trips (one trip shows a
sentence instead). Trips are a list of rows, not a 5-column table.

### Prices
A record-a-price card, then prices listed as rows.

## 4. Platform

- **Install:** PNG icons (180 apple-touch, 192, 512, 512 maskable), the
  `apple-mobile-web-app-*` metas, `viewport-fit=cover`, and a theme colour per
  scheme.
- **Cold start (F11):**
  - The service worker races navigations against 4s. If the server has not
    answered by then, it shows a branded "Waking ghrub up…" screen. That
    screen polls `/healthz` and reloads the moment the server is up.
  - A GitHub Actions cron pings `/healthz` every 10 minutes from 05:00 to 22:00
    SAST, so the service is usually awake when you open the app. One free
    service running all month fits Render's free-hours allowance.
- **Reference data (F1):** the 13 categories and 3 stores are inserted on every
  boot by `upgrades.sql` (`ON CONFLICT DO NOTHING`). A fresh or unseeded
  database can always file an item.

## 5. Definition of done
- Every screen at 375 and 393px wide: no horizontal page scroll, no text under
  13px (chart axis labels excepted: they are drawn at phone width so they land
  at ~10–11px), and every target ≥ 44px. Checked in both light and dark.
- F1–F11 each fixed and, where testable, pinned by a test.
- `npm test`, lint and format green; promoted dev → staging → main; production
  serves the new UI and `/healthz` answers.
