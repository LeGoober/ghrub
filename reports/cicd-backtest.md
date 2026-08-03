# CI/CD backtest — M0 & M1

Audit of what the pipeline **actually did** for the milestones already shipped,
measured against the practices `docs/03-milestones.md`, `docs/04-devops-cicd.md`
and `docs/05-agent-runbook.md` say are mandatory.

**Audited:** 2026-08-03 · commits `c79745f` … `417faf9` (10 commits, M0 + M1)
**Verdict:** the *code* met its Definition of Done; the *delivery process* did
not. Every milestone gate that exists on paper was bypassed, and the one defect
that reached a deployable artefact (`417faf9`, SIGSEGV) was caught by hand
because CI is structurally incapable of catching it.

---

## Findings

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| **B1** | **No pull requests, ever.** The documented flow is `feature/* → PR → dev → PR → staging → PR → main`. All 10 commits were pushed straight to `dev`, then `staging` and `main` were fast-forwarded to the same SHA. | `gh pr list --state all` → empty. `git log --all --decorate` shows `dev`, `staging`, `main`, `feature/m1-data-list` all at `417faf9`. | High |
| **B2** | **No tracking issues, no GitHub milestones.** `docs/03` § Tracking convention requires one milestone + one tracking issue per M{n}, and PR bodies that cite DoD evidence. `scripts/gh-bootstrap.sh` existed but was never run. | `gh issue list --state all` → empty. `gh api repos/:owner/:repo/milestones` → `[]`. | Medium |
| **B3** | **No branch protection anywhere.** `docs/04` requires `main` and `staging` to demand a PR + a passing `ci` check. Nothing enforced it, which is *why* B1 was possible. | `gh api repos/.../branches/{dev,main}/protection` → `404 Branch not protected`. | High |
| **B4** | **Both deploy workflows red; nothing is deployed.** Every push to `staging`/`main` fails at the secrets guard. M0's DoD ("Render shows a live URL whose `/healthz` returns 200") is **not met**. | Runs `30707048633` (production) and `30707044745` (staging): guard step logs `KEY:` / `SID:` empty → `exit 1`. `gh secret list` → empty. | High — blocked on a human step |
| **B5** | **CI cannot catch a runtime failure.** The `docker` job runs `docker build` and stops. `docker build` proves the image *compiles*, never that it *runs* — so the better-sqlite3 SIGSEGV was invisible to a fully green pipeline. It was found by a human running the container. | `417faf9` commit message: *"The image built but crashed on boot (exit 139) — verified independently by running the container, not just building it."* Prior `ci` runs: green. | High |
| **B6** | **Seed idempotency was never verified by CI**, despite being a hard rule in `docs/05`. The step ran `node scripts/seed.js` exactly once — a seed that duplicated rows on re-run would have passed. | Old `ci.yml`: `[ -f scripts/seed.js ] && node scripts/seed.js \|\| echo "no seed yet"`. | Medium |
| **B7** | **Third-party action pinned to a mutable tag** while holding `RENDER_API_KEY`. `johnbeynon/render-deploy-action@v0.0.8` — a retagged release would run unreviewed code with the deploy key. | Old `deploy-*.yml`. | Medium |
| **B8** | **No PR template**, so the "PR body cites DoD evidence + links the tracking issue" convention had no surface to be enforced on. | No `.github/pull_request_template.md`. | Low |
| **B9** | **One CI run covered all of M1.** The six M1 commits were pushed as a single batch, so only the head commit was ever built. Per-commit regressions in that range were never independently verified. | `gh run list`: `ci` on `dev` at 13:54 (`fcf7ebb`, pre-M1) then 15:56 (`417faf9`, all of M1). | Low |

## What was actually green

Not everything failed — worth recording, because these are the parts to keep:

- `ci` on `dev` passed on every push it ran for (3/3 runs): lint, format check,
  22 tests, docker build.
- M1's code deliverables genuinely meet their DoD — `reports/M1-checklist.md`
  rows are backed by real commands and real output.
- Commit history is scoped and readable (`M1: add schema, repository and
  migration runner`, etc.) — the `docs/05` rule about no `wip` dumps held.

---

## Remediation

Landed in `chore/cicd-backtest` (this PR — itself the first PR the repo has
ever had, which is the point):

| Finding | Fix |
|---------|-----|
| B1, B3 | `scripts/gh-bootstrap.sh` now applies branch protection to `dev`, `staging`, `main`: PR required, `build-test` + `docker` must pass, `strict` (branch must be up to date), no force-push, no deletion. Solo-repo calibration: `required_approving_review_count: 0` (a solo dev cannot approve their own PR, so 1 would deadlock) and `enforce_admins: false` (owner keeps an escape hatch). The CI gate is the part that bites. |
| B2 | `gh-bootstrap.sh` now creates the six milestones **and** the six tracking issues, each with its deliverables as a checklist and its DoD quoted. Idempotent — re-running is a drift check. |
| B4 | Deploy workflows now gain `workflow_dispatch` (retry from the Actions tab once secrets land, no empty commit needed) and the guard writes an actionable `$GITHUB_STEP_SUMMARY` with the exact `gh secret set` commands. **Still blocked on the human step** — see below. |
| B5 | New `Container smoke test — boot, serve, survive` step: runs the built image, waits for `/healthz`, then drives `/` and `/trips` (the DB-backed routes where the native addon actually loads), then asserts the container is *still running* and reports the exit code (139 = SIGSEGV). This is the manual check from `417faf9`, institutionalised. |
| B6 | Seed smoke now imports **twice** and fails if the row counts differ. |
| B7 | `render-deploy-action` pinned to commit `a0588f9a…` with the version in a trailing comment. |
| B8 | `.github/pull_request_template.md` — DoD evidence, verification commands, and the `docs/05` hard rules as a checklist. |
| B9 | Addressed by B1/B3: with PRs required, every branch gets its own CI run before it can land. |

### Still open — needs a human

**B4 is not fixable from here.** The Render API key lives in Rorisang's terminal
and GitHub secrets, not in this session (`docs/04` notes this explicitly). To
close M0's DoD:

1. Render Dashboard → **New → Blueprint** → pick `ghrub` → creates `ghrub`
   (branch `main`) and `ghrub-staging` (branch `staging`) from `render.yaml`.
2. Copy both `srv-…` ids.
3. ```bash
   gh secret set RENDER_API_KEY --body "$RENDER_API_KEY"
   gh secret set RENDER_SERVICE_ID_STAGING    --body "srv-xxxxxxxx"
   gh secret set RENDER_SERVICE_ID_PRODUCTION --body "srv-yyyyyyyy"
   ```
4. Optionally set repo **variables** `STAGING_URL` / `PRODUCTION_URL` (e.g.
   `https://ghrub.onrender.com`) — the deploy workflows will then poll the live
   `/healthz` after deploying and fail if the service is not actually serving.
5. Re-run `deploy-production` from the Actions tab.

Until then the deploy jobs stay red **on purpose**: a red X is the honest signal
that nothing is deployed. Making them silently skip would turn a green tick into
a lie about production.

---

## The rule going forward

M2 through M5 each go: tracking issue → `feature/m{n}-<slug>` → scoped commits →
`reports/M{n}-checklist.md` with real evidence → PR into `dev` citing the DoD →
CI green → promote `dev → staging → main`. Branch protection now enforces the
parts that were previously honour-system.
