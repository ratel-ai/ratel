#!/usr/bin/env bash
# Make the PR merge gate mandatory on `main`, and create the two control labels.
#
# Enforced on main (via a repository ruleset):
#   - a pull request is required before merging
#   - the `pr-gate` status check must pass (see .github/workflows/pr-gate.yml).
#     `pr-gate` fails any PR without the `ready-to-merge` label, so this single
#     required check encodes both "label present" AND "full pipeline green".
#   - no force-push / branch deletion
#
# Labels:
#   - `ready-to-merge`  arms the gate (runs the artifact build + cross-SDK E2E) and is
#                       required to merge. Add it when a PR is ready to land.
#   - `override-checks` manual escape hatch: forces `pr-gate` green even when the checks
#                       are RED, so the PR can still be merged. By CONVENTION this is
#                       rstagi-only and for emergencies — GitHub cannot restrict who
#                       applies a label or who clicks merge, so this is a process rule,
#                       not a hard control. The gate emits a loud warning when it's used.
#
# There are intentionally NO ruleset bypass actors: the override is the label, not a
# privileged user — so "even rstagi has a block" (he must add the label to merge red).
#
# Requirements: `gh` authenticated with repo-admin on $REPO. Run it yourself.
#
# Usage:
#   ./scripts/setup-branch-ruleset.sh
#   REPO=ratel-ai/ratel BRANCH=main ./scripts/setup-branch-ruleset.sh
set -euo pipefail

REPO="${REPO:-ratel-ai/ratel}"
BRANCH="${BRANCH:-main}"
RULESET_NAME="${RULESET_NAME:-PR merge gate}"
CHECK_CONTEXT="${CHECK_CONTEXT:-pr-gate}"

command -v gh >/dev/null || { echo "error: gh CLI not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated" >&2; exit 1; }

# --- ruleset payload (no bypass actors) --------------------------------------
payload="$(cat <<JSON
{
  "name": "$RULESET_NAME",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": { "include": ["refs/heads/$BRANCH"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [ { "context": "$CHECK_CONTEXT" } ]
      }
    }
  ]
}
JSON
)"

# --- create or update (idempotent) -------------------------------------------
existing_id="$(gh api "/repos/$REPO/rulesets?includes_parents=false" \
  --jq ".[] | select(.name == \"$RULESET_NAME\") | .id" 2>/dev/null | head -1 || true)"

if [ -n "$existing_id" ]; then
  echo "Updating existing ruleset #$existing_id on $REPO…"
  printf '%s' "$payload" | gh api -X PUT "/repos/$REPO/rulesets/$existing_id" --input - >/dev/null
  echo "  updated."
else
  echo "Creating ruleset '$RULESET_NAME' on $REPO…"
  printf '%s' "$payload" | gh api -X POST "/repos/$REPO/rulesets" --input - >/dev/null
  echo "  created."
fi

# --- labels -------------------------------------------------------------------
ensure_label() {
  local name="$1" color="$2" desc="$3"
  if gh label list --repo "$REPO" --search "$name" --json name --jq '.[].name' 2>/dev/null | grep -qx "$name"; then
    echo "Label '$name' already exists."
  else
    gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" >/dev/null \
      && echo "Created label '$name'." || echo "  (could not create '$name'; create it manually)"
  fi
}
ensure_label "ready-to-merge" FBCA04 "Arm the PR merge gate (artifact build + cross-SDK E2E); required to merge."
ensure_label "override-checks" B60205 "Force pr-gate green to merge despite RED checks. Emergency escape hatch — rstagi only."

echo
echo "Done. Verify: GitHub → $REPO → Settings → Rules → '$RULESET_NAME'."
echo "  - required check: $CHECK_CONTEXT  (no bypass actors)"
echo "  - labels: ready-to-merge (arm + required), override-checks (emergency merge of red)"
