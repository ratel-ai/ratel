#!/usr/bin/env bash
# Create/update the branch ruleset that makes the PR merge gate mandatory on `main`.
#
# What it enforces on main:
#   - a pull request is required before merging
#   - the `pr-gate` status check must pass (see .github/workflows/pr-gate.yml).
#     `pr-gate` itself fails any PR lacking the `ready-to-merge` label, so this single
#     required check encodes BOTH "label present" AND "full pipeline green".
#   - no force-push / branch deletion
#
# Bypass (the "force pusher" override):
#   By default, bypass is granted to the repository **admin** role (BYPASS_ROLE=admin).
#   rstagi is expected to be a repo admin, so he can force-push / merge over the gate.
#   GitHub repository-ruleset bypass actors are roles / teams / apps — an individual
#   user cannot be named directly. To scope the override to ONLY rstagi (not every
#   admin), create a single-member team and pass its slug:
#
#       gh api -X POST /orgs/ratel-ai/teams -f name='release-overriders' -f privacy='closed'
#       gh api -X PUT  /orgs/ratel-ai/teams/release-overriders/memberships/rstagi -f role='member'
#       BYPASS_TEAM=release-overriders ./scripts/setup-branch-ruleset.sh
#
# Requirements: `gh` authenticated with repo-admin on $REPO. Run it yourself.
#
# Usage:
#   ./scripts/setup-branch-ruleset.sh                 # admin-role bypass (default)
#   BYPASS_TEAM=release-overriders ./scripts/...      # scope bypass to one team
#   REPO=ratel-ai/ratel BRANCH=main ./scripts/...     # override target
set -euo pipefail

REPO="${REPO:-ratel-ai/ratel}"
BRANCH="${BRANCH:-main}"
RULESET_NAME="${RULESET_NAME:-PR merge gate}"
CHECK_CONTEXT="${CHECK_CONTEXT:-pr-gate}"
BYPASS_ROLE="${BYPASS_ROLE:-admin}"        # used when BYPASS_TEAM is unset
BYPASS_TEAM="${BYPASS_TEAM:-}"             # team slug; scopes bypass to that team
LABEL="${LABEL:-ready-to-merge}"

command -v gh >/dev/null || { echo "error: gh CLI not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated" >&2; exit 1; }

ORG="${REPO%%/*}"

# --- resolve the bypass actor -------------------------------------------------
if [ -n "$BYPASS_TEAM" ]; then
  echo "Resolving team '$ORG/$BYPASS_TEAM' for bypass…"
  team_id="$(gh api "/orgs/$ORG/teams/$BYPASS_TEAM" --jq '.id')"
  bypass_actors="$(printf '[{"actor_id":%s,"actor_type":"Team","bypass_mode":"always"}]' "$team_id")"
  echo "  bypass: team $BYPASS_TEAM (id $team_id)"
else
  case "$BYPASS_ROLE" in
    admin) role_id=5 ;;
    maintain) role_id=4 ;;
    write) role_id=3 ;;
    *) echo "error: BYPASS_ROLE must be admin|maintain|write" >&2; exit 1 ;;
  esac
  bypass_actors="$(printf '[{"actor_id":%s,"actor_type":"RepositoryRole","bypass_mode":"always"}]' "$role_id")"
  echo "  bypass: repository role '$BYPASS_ROLE' (id $role_id)"
  echo "  note: this grants bypass to ALL repo admins. Use BYPASS_TEAM=<slug> to scope to rstagi only."
fi

# warn if rstagi is not actually an admin (so the override would not apply)
perm="$(gh api "/repos/$REPO/collaborators/rstagi/permission" --jq '.permission' 2>/dev/null || echo 'unknown')"
echo "  rstagi permission on $REPO: $perm"
if [ -z "$BYPASS_TEAM" ] && [ "$perm" != "admin" ]; then
  echo "  WARNING: rstagi is not a repo admin ($perm); admin-role bypass would not cover him." >&2
fi

# --- build the ruleset payload ------------------------------------------------
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

# --- ensure the label exists --------------------------------------------------
if gh label list --repo "$REPO" --search "$LABEL" --json name --jq '.[].name' 2>/dev/null | grep -qx "$LABEL"; then
  echo "Label '$LABEL' already exists."
else
  echo "Creating label '$LABEL'…"
  gh label create "$LABEL" --repo "$REPO" \
    --color FBCA04 --description "Arm the PR merge gate (full artifact build + cross-SDK E2E); required to merge." \
    >/dev/null && echo "  created." || echo "  (could not create label; create it manually)"
fi

echo
echo "Done. Verify: GitHub → $REPO → Settings → Rules → '$RULESET_NAME'."
echo "  - required check: $CHECK_CONTEXT"
echo "  - merge gate label: $LABEL"
echo "  - bypass: ${BYPASS_TEAM:+team $BYPASS_TEAM}${BYPASS_TEAM:-role $BYPASS_ROLE}"
