<!--
Title convention (docs/03-milestones.md § Tracking convention): `M{n}: <summary>`
Non-milestone work: `chore:` / `fix:` / `docs:` + a summary.
-->

## What

<!-- One paragraph. What does this PR deliver? -->

## Milestone

- Closes #<!-- tracking issue number -->
- Milestone: <!-- M0 … M5, or "n/a" -->

## Definition of Done evidence

<!--
Paste the ticked table from reports/M{n}-checklist.md, or state DoD evidence
directly. "It compiles" is not evidence — each row needs a command and its
observed output. Nothing is Done until the evidence exists (reports/README.md).
-->

## Verification run locally

```
npm run lint     #
npm run format   #
npm test         #
npm run seed     # twice — identical counts (idempotent)
docker build -t ghrub:ci .   #
```

## Checklist

- [ ] Commit history is scoped and readable — no `wip`/`fix` dumps hiding the work
- [ ] Route → `repo.js` → service/insights → EJS view; no new dependency without justification
- [ ] Money is integer cents end-to-end
- [ ] All DB access goes through `src/db/repo.js`
- [ ] Every mutation returns an HTMX partial, not a full page
- [ ] Seed stays idempotent
- [ ] No secrets in code — `process.env` only
- [ ] CI green on this PR
