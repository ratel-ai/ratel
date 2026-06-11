#!/usr/bin/env bash
# Make the PR merge gate mandatory on `main`, with rstagi as a superadmin bypass.
#
# Policy:
#   - everyone must have the `pr-gate` check green to merge (which requires the
#     `ready-to-merge` label to have armed + passed the artifact build + cross-SDK E2E)
#   - a PR is required; no force-push / branch deletion
#   - rstagi BYPASSES all of it — he can merge any PR at any time, red or green
#
# Enforced on `main` via a repository ruleset. The bypass is the only soft spot, and it
# is scoped to rstagi: by default via the repository **admin** role (so any repo admin
# can bypass — fine if rstagi is the only/trusted admin). To scope to EXACTLY rstagi and
# no other admin, create a one-member team and pass its slug:
#
#     gh api -X POST /orgs/ratel-ai/teams -f name='ratel-mergers' -f privacy='closed'
#     gh api -X PUT  /orgs/ratel-ai/teams/ratel-mergers/memberships/rstagi -f role='member'
#     BYPASS_TEAM=ratel-mergers ./scripts/setup-branch-ruleset.sh
#
# Requirements: `gh` authenticated with repo-admin on $REPO. Run it yourself.
#
# Usage:
#   ./scripts/setup-branch-ruleset.sh                  # admin-role bypass (default)
#   BYPASS_TEAM=ratel-mergers ./scripts/...            # scope bypass to exactly that team
set -euo pipefail

REPO="${REPO:-ratel-ai/ratel}"
BRANCH="${BRANCH:-main}"
RULESET_NAME="${RULESET_NAME:-PR merge gate}"
CHECK_CONTEXT="${CHECK_CONTEXT:-pr-gate}"
BYPASS_TEAM="${BYPASS_TEAM:-}"

command -v gh >/dev/null || { echo "error: gh CLI not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated" >&2; exit 1; }

ORG="${REPO%%/*}"

# --- resolve the bypass actor -------------------------------------------------
if [ -n "$BYPASS_TEAM" ]; then
  team_id="$(gh api "/orgs/$ORG/teams/$BYPASS_TEAM" --jq '.id')"
  bypass_actors="$(printf '[{"actor_id":%s,"actor_type":"Team","bypass_mode":"always"}]' "$team_id")"
  echo "bypass: team '$BYPASS_TEAM' (id $team_id) — scoped to its members only"
else
  # RepositoryRole id 5 = admin
  bypass_actors='[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}]'
  echo "bypass: repository 'admin' role (any repo admin can merge past the gate)"
  admins="$(gh api "/repos/$REPO/collaborators?affiliation=direct&permission=admin" --jq '[.[].login] | join(", ")' 2>/dev/null || echo '?')"
  echo "  current admins: $admins"
  echo "  rstagi should be one of them; if there are admins you DON'T want bypassing,"
  echo "  re-run with BYPASS_TEAM=<one-member-team> to scope strictly to rstagi."
fi

# --- ruleset payload ----------------------------------------------------------
payload="$(cat <<JSON
{
  "name": "$RULESET_NAME",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": $bypass_actors,
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

# --- label --------------------------------------------------------------------
if gh label list --repo "$REPO" --search ready-to-merge --json name --jq '.[].name' 2>/dev/null | grep -qx "ready-to-merge"; then
  echo "Label 'ready-to-merge' already exists."
else
  gh label create ready-to-merge --repo "$REPO" --color FBCA04 \
    --description "Arm the PR merge gate (artifact build + cross-SDK E2E); required to merge." >/dev/null \
    && echo "Created label 'ready-to-merge'." || echo "  (create 'ready-to-merge' manually)"
fi

echo
echo "Done. Verify: GitHub → $REPO → Settings → Rules → '$RULESET_NAME'."
echo "  - required check: $CHECK_CONTEXT"
echo "  - everyone: needs pr-gate green (ready-to-merge label + all checks pass) to merge"
echo "  - bypass: ${BYPASS_TEAM:+team $BYPASS_TEAM}${BYPASS_TEAM:-admin role} — can merge any PR, red or green"
