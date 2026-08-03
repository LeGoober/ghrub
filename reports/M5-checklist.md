# M5 — Polish + optional LLM — checklist

**Spec refs:** `docs/03-milestones.md` (M5) · `docs/06-routes-and-ui.md` ·
`docs/04-devops-cicd.md` · `docs/05-agent-runbook.md`
**Branch:** `feature/m5-polish-llm` → PR into `dev`
**Tracking issue:** #6
**DoD source:** "Lighthouse mobile pass; LLM flag off by default and app fully
works without it; tag `v0.2.0`."

---

## Deliverables

| # | Deliverable | Ref | Lands in | Prove it | Expected | Done |
|---|-------------|-----|----------|----------|----------|------|
| 1 | Design pass (mobile-first, aisle-usable) | docs/03 | `public/css/app.css` | `npm test -- polish` | 44px targets, sticky budget bar, focus ring, reduced motion | ☑ |
| 2 | Dark mode | docs/03 (deferred from M2) | `public/css/app.css` | `npm test -- polish` | re-stepped tokens, `--chart-mark` re-picked | ☑ |
| 3 | PWA manifest / installable | docs/03 | `public/manifest.webmanifest`, `public/sw.js`, `public/icon*.svg` | `npm test -- polish` | manifest + root-scoped worker + maskable icon | ☑ |
| 4 | Empty states | docs/03 | all index views | `npm test -- polish` | 5 pages guide a new user | ☑ |
| 5 | Error states | docs/03, docs/06 | `src/views/error-page.ejs`, `src/server.js` | `npm test -- polish` | real 404/500 pages, no `Cannot GET` | ☑ |
| 6 | "Explain this shop" behind `ENABLE_LLM` | docs/03, docs/06 | `src/lib/explain.js`, `GET /trips/:id/explain` | `npm test -- explain` | 404 when off; one Messages API call when on | ☑ |
| 7 | LLM off by default, app fully works without it | docs/03 **(DoD)** | as above | `npm test -- explain` | route 404s, no trigger rendered, everything else intact | ☑ |

## Verification commands (run and recorded)

```bash
npm run lint     # 0 errors, 0 warnings                      -> PASSED
npm run format   # All matched files use Prettier code style -> PASSED
npm test         # 12 files, 127 tests, all passing          -> PASSED
                 #   (101 before M5)
```

## The LLM call — decisions a reviewer should check

**Why `fetch` and not `@anthropic-ai/sdk`.** `docs/05` forbids a new dependency
unless Express + better-sqlite3 genuinely cannot do it. Shipping an SDK in every
production image for one optional, disabled-by-default call does not clear that
bar; this is a single POST to `/v1/messages`. Node 20 has `fetch` and
`AbortSignal.timeout` built in, so the dependency count is unchanged.

**Three API details that were verified, not assumed** — each would have been a
live bug:

| Detail | Why it matters here |
|---|---|
| **Thinking is ON by default on Claude Opus 5**, and `max_tokens` caps thinking *plus* response text | A budget sized for ~120 words of prose truncates mid-sentence. Cap is 4096; `effort: "low"` is what keeps it cheap. |
| **`temperature` / `top_p` / `top_k` are rejected with a 400** on this model | Voice is steered by the system prompt instead. A test asserts we never send them. |
| **A safety classifier can decline with HTTP 200** + `stop_reason: "refusal"` and empty `content` | `stop_reason` is checked before reading `content`; `fallbacks: "default"` lets Anthropic re-run a decline on a fallback model. |

**Safety of what is sent.** `buildFactSheet()` is a pure function, so exactly
what leaves the machine is readable in one place: trip name, dates, totals,
category subtotals, bucket item names, cadence, cheapest store. No API key is
ever logged, and error bodies are never surfaced verbatim (they can echo request
content).

**Prompt discipline.** The system prompt tells the model to use only the given
facts and never to invent an item, price or trend — the numbers are already
computed by ghrub, the model only narrates them.

## The service worker decision

It caches **only the static shell**. ghrub's value is live data — what is on the
list right now, what you just ticked — so serving a stale list mid-shop is worse
than an honest "you are offline" page. Navigations and every mutation go to the
network; a failed navigation gets a plain offline page, never a cached copy of
someone's list. Asserted by `polish.test.js`.

Both the manifest and the worker are served from the **root**, not `/static`: a
service worker can only control paths below its own URL, so `/static/sw.js`
could never intercept `/` or `/trips/:id`.

## Bug found during the design pass

Two hardcoded `#fff` surfaces — form controls and the type-ahead dropdown —
would have rendered white-on-dark once dark mode landed. Both now use the
surface token, and `polish.test.js` guards against new ones.

## Lighthouse

The DoD asks for a "Lighthouse mobile pass". Lighthouse needs a headless browser
that is not available in this environment, so the checkable substitutes are
asserted in tests instead: viewport meta, ≥44px tap targets, a theme colour, a
linked manifest with a maskable icon, a registered service worker, a skip link,
visible focus states, `prefers-reduced-motion`, and semantic landmarks.
**A real Lighthouse run against the deployed URL is still owed** and is listed
as an open item on the tracking issue — it cannot be produced honestly from here.

## Gotchas re-checked (reports/README.md)

1. `.dockerignore` — `public/` was already copied by the Dockerfile, and the new
   assets live there, so the manifest/worker/icons ship. No new `COPY`. ✔
2. Money: M5 only formats existing cents for the prompt. ✔
3. Idempotency: seed untouched; CI still imports twice with identical counts. ✔
4. Docker build is CI's authority. ✔
5. Container smoke test still boots the image and drives DB-backed routes. ✔

## Commit history (scoped, reviewable)

- `M5: add the optional "Explain this shop" summary`
- `M5: make ghrub installable, with honest offline and error states`
- `M5: design pass — dark mode, focus, reduced motion`
- `M5: cover the flag being off, and the states nobody looks at`
- `M5: record the M5 checklist`

## DoD statement (PR body)

> The LLM flag is off by default and the app is fully usable without it — the
> route 404s, no trigger renders, and every other surface is unchanged (three
> tests assert exactly this). ghrub is installable with a root-scoped service
> worker, has real 404/500 pages, empty states on all five index pages, a
> selected dark mode, visible focus and reduced-motion support. 127 tests green
> (up from 101). Lighthouse itself cannot run here — its checkable components
> are asserted in tests and a real run is left open on #6.
