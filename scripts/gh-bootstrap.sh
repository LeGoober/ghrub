#!/usr/bin/env bash
# One-time GitHub setup for ghrub: milestones, labels, tracking issues.
# Requires the `gh` CLI, authenticated (`gh auth login`), run from repo root
# with a remote already set.
set -euo pipefail

echo "Creating labels..."
gh label create "MVP"   --color 2da44e --description "Ships in v0.1 MVP" 2>/dev/null || true
gh label create "v0.2"  --color 8250df --description "Post-MVP"          2>/dev/null || true
gh label create "milestone" --color 0969da --description "Milestone tracking issue" 2>/dev/null || true

echo "Creating milestones..."
create_ms () { gh api repos/{owner}/{repo}/milestones -f title="$1" -f description="$2" >/dev/null 2>&1 || true; }
create_ms "M0 Foundations & pipeline" "Repo, CI, Docker, Render deploy green"
create_ms "M1 Data layer + running list" "Schema, seed, trip CRUD, list + budget bar"
create_ms "M2 Habit intelligence" "Regulars / new / forgotten, spend history"
create_ms "M3 Store price comparison" "Per-store basket totals, cheapest store"
create_ms "M4 Recipes + inventory" "Meal log decrements inventory, low-stock alerts"
create_ms "M5 Polish + optional LLM" "Design pass, PWA, LLM summary behind a flag"

echo "Done. See docs/03-milestones.md for each milestone's deliverables + DoD."
echo "Next: open a tracking issue per milestone with its deliverables as a checklist."
