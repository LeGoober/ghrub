# M{n} — <milestone title> — checklist

> Copy this file to `reports/M{n}-checklist.md` and tick as you go. Each row
> needs real evidence: run the command, paste the observable result. See
> `reports/README.md` for the loop and gotchas.

**Spec refs:** `docs/03-milestones.md` (M{n}) · `docs/01-product-spec.md` ·
`docs/02-data-model.md` · `docs/06-routes-and-ui.md` · `docs/05-agent-runbook.md`
**Branch:** `feature/m{n}-<slug>` → PR into `dev`
**DoD source:** the Definition of Done line for M{n} in `docs/03-milestones.md`

---

## Deliverables

| # | Deliverable | Ref | Lands in | Prove it | Expected | Done |
|---|-------------|-----|----------|----------|----------|------|
| 1 | ... | docs/0x | `src/...` | `command` | outcome | ☐ |

## Verification commands

```bash
npm run lint          # 0 errors, 0 warnings
npm run format        # All matched files use Prettier code style!
npm test              # N passing
npm run seed          # idempotent: identical counts on second run
docker build -t ghrub:ci .   # builds to the end, image exported
```

## Gotchas to re-check

1. `.dockerignore` never excludes a directory the Dockerfile `COPY`s (see
   `reports/README.md` gotcha 1).
2. Money stays integer cents end-to-end (gotcha 2).
3. Idempotency for any upsert whose table lacks a unique key — look it up
   instead of `ON CONFLICT` (gotcha 3).
4. If a Docker build fails locally on Docker Desktop with weird checksum
   errors, try the explicit-file `COPY`; trust CI on `ubuntu-latest` (gotcha 4).

## Commit history (scoped, reviewable)

- `M{n}: ...`
- ...

## DoD statement (paste into PR body)

> <The Definition of Done from docs/03-milestones.md>, with CI green
> (lint + format + test + seed smoke + docker build). Evidence: see checklist
> rows above.
