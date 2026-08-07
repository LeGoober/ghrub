# 00 — Quick decisions (locked)

You asked for fast, decisive calls so FreeBuff can just build. Here they are,
with the one honest trade-off called out at the end.

## The stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Frontend** | **HTMX** + a little **Alpine.js**, server-rendered HTML | You asked for HTMX. No SPA build step, no client framework. Server sends HTML fragments; HTMX swaps them. Alpine only for tiny local UI state (toggles). |
| **Templating** | **EJS** | Boring, ubiquitous, zero surprises for a coding agent. Renders the HTMX partials. |
| **Backend** | **Node.js 20 + Express** | You said "JS stack." Express is the most documented, hardest-to-get-wrong Node server — best odds a free agent finishes it. Light: ~1 dependency. |
| **Database** | **Postgres** via `pg`, hosted on **Neon** | Was SQLite via `better-sqlite3`; migrated to Neon so the app needs no persistent disk and can run on Render's free plan. Tests use **PGlite** (Postgres as WASM, in-process) so `npm test` still needs no server. |
| **Migrations/seed** | Plain SQL files + a tiny runner | No ORM. Schema in `src/db/schema.sql`, seed from `docs/seed/grocery-history.json`. |
| **Tests** | **Vitest** | Fast, ESM-native, trivial config. |
| **Lint/format** | **ESLint + Prettier** | CI gate. |
| **Container** | **Docker** (`node:20-alpine`, multi-stage) | You wanted a hosted Docker instance. |
| **Host** | **Render** Web Service (from `render.yaml`) | Your existing Render workflow; API key already in your env. |

## Why not the alternatives you floated

- **HTMX + H2 (Java/Spring):** H2 is a *Java* database — it pulls in the whole
  JVM/Spring toolchain, which fights "JS stack" and "extremely light." SQLite
  gives you the same embedded-single-file feeling in the Node world. **Kept
  your intent, dropped the JVM.**
- **Vercel:** great for serverless/edge, but it's a poor fit for a
  long-lived SQLite file + a Docker image. Render Web Service + a persistent
  disk (or Postgres) is the cleaner path for stateful history. **Render it is.**

## Where the data lives (resolved)

This used to be the one open trade-off: SQLite needs a filesystem that survives
restarts, and on Render that means a persistent disk, which requires a paid
instance type. **Resolved by taking the fallback:** storage moved to a free
**Neon** Postgres, so the web service holds no state at all and runs on the
free plan. All DB access sat behind `src/db/repo.js`, which is exactly what
kept the swap contained rather than a rewrite.

One constraint this introduces: keep the Render region matched to the Neon
region (both `ohio` / `us-east-2`). A page render issues several queries, and a
cross-continent hop is paid on every one of them.

`render.yaml` ships configured for the disk path. If you choose free Postgres,
M0's runbook note tells FreeBuff exactly what to change.

## What "AI automation" means in the MVP (be honest about it)

The MVP intelligence is **rule-based analytics over your own history** — fast,
explainable, no API key, no cost:

- **Regulars** = items bought in ≥ 50% of past trips.
- **New item** = on this list but rarely/never in history.
- **Budget** = live subtotal vs budget, plus per-category historical average.
- **Cheapest store** = sum the basket at each store from your recorded prices.
- **Low stock** = inventory decremented by logged meals, below its threshold.

An optional **LLM insight layer** (natural-language "here's your shop this
week" summary) is scoped in M5 as `[v0.2]`, behind a feature flag, using the
latest Claude model — never required for the app to work.
