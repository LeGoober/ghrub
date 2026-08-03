# reports — driving checklists for spec-driven design

This folder turns the prose spec in `docs/` into **executable checklists** that
drive each milestone and let Claude Code (and any reviewer) verify a PR against
its Definition of Done without re-reading everything from scratch.

The loop (from `docs/05-agent-runbook.md`):

1. Pick a milestone in `docs/03-milestones.md`.
2. Copy `reports/_milestone-template.md` → `reports/M{n}-checklist.md`.
3. Implement against `docs/01`, `docs/02`, `docs/06` — ticking the checklist as
   you go, recording **evidence** (file + command + expected result).
4. Run the checklist's **Verification commands**; fix anything red.
5. Open the PR `feature/... → dev`; paste the checklist into the PR body as the
   DoD evidence.
6. Claude Code re-runs the verification commands, ticks the same checklist, and
   only then promotes `dev → staging → main`.

## Checklist index

| Checklist | Milestone | Status |
|-----------|-----------|--------|
| [M1 — data layer + running list](M1-checklist.md) | M1 `[MVP]` | ✔ implemented, CI-green locally (see file) |
| [CI/CD backtest — M0 & M1](cicd-backtest.md) | audit | ✔ findings + remediation; B4 open (needs Render secrets) |
| [M2 — habit intelligence](M2-checklist.md) | M2 `[MVP]` | ✔ implemented, 52 tests green (see file) |
| [M3 — store price comparison](M3-checklist.md) | M3 `[MVP]` | ✔ implemented, 74 tests green (see file) |
| [M4 — recipes → inventory](M4-checklist.md) | M4 `[v0.2]` | ✔ implemented, 101 tests green (see file) |
| `_milestone-template.md` | M5 | template |

## Evidence conventions

Each deliverable row uses:

- **Ref** — the spec doc/section that defines it (authoritative).
- **Lands in** — the file(s) that implement it.
- **Prove it** — one command (or manual step) that produces observable evidence.
- **Expected** — the exact outcome the verifier must see.

"Ticked" means a human or Claude Code ran the command and saw the expected
outcome — not that the code exists. Nothing is Done until the evidence exists.

## Known gotchas (learned in M1 — re-check every milestone)

1. **`.dockerignore` vs `docs/`**: excluding `docs` silently breaks any
   `COPY docs/...` in the Dockerfile. The repo now excludes docs prose via
   `*.md` and ships the seed JSON with an explicit-file `COPY`.
2. **Money**: `grocery-history.json` prices are whole ZAR; the schema stores
   integer cents. The seed must ×100 (`src/lib/money.js` `toCents`).
3. **`trip` has no unique key** — a bare `INSERT ... ON CONFLICT` can't make
   trips idempotent. Upsert by name (`upsertTripByName`).
4. **Docker Desktop (Windows) buildkit quirk**: `COPY docs/seed ./docs/seed`
   (directory copy) failed locally with mutating checksum errors; copying the
   explicit file works. CI (`ubuntu-latest`) is the authoritative gate.
5. **A green `docker build` is not a working image.** M1's native-addon
   SIGSEGV compiled fine and died on boot. CI now boots the image and drives
   DB-backed routes (`reports/cicd-backtest.md` B5) — but when you touch the
   Dockerfile, `better-sqlite3`, or the Node version, still run the container
   yourself before trusting the tick.
6. **Governance is not self-enforcing.** M0 and M1 shipped with zero PRs, zero
   tracking issues and no branch protection, because nothing made them
   mandatory. Branch protection now does; keep it on.
