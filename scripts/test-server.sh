#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${AGENTIFIED_URL:-http://localhost:9119}"
PASSED=0
FAILED=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${YELLOW}▶${NC} $1"; }
pass() { echo -e "${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); TOTAL=$((TOTAL + 1)); }
fail() { echo -e "${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); TOTAL=$((TOTAL + 1)); }

assert_contains() {
  local response="$1" expected="$2" label="$3"
  if echo "$response" | grep -q "$expected"; then
    pass "$label"
  else
    fail "$label — expected '$expected' in response"
    echo "  Response: $response"
  fi
}

assert_top_tool() {
  local response="$1" expected="$2" label="$3"
  local first_tool
  first_tool=$(echo "$response" | jq -r '.tools[0].name // empty')
  if [ "$first_tool" = "$expected" ]; then
    pass "$label (top: $first_tool)"
  else
    fail "$label — expected top tool '$expected', got '$first_tool'"
    echo "  All tools: $(echo "$response" | jq -r '[.tools[].name] | join(", ")')"
  fi
}

assert_in_top_n() {
  local response="$1" expected="$2" n="$3" label="$4"
  local found
  found=$(echo "$response" | jq -r --arg name "$expected" --argjson n "$n" \
    '[.tools[:$n][].name] | map(select(. == $name)) | length')
  if [ "$found" -gt 0 ]; then
    pass "$label ('$expected' in top $n)"
  else
    fail "$label — '$expected' not in top $n"
    echo "  Top $n: $(echo "$response" | jq -r --argjson n "$n" '[.tools[:$n][].name] | join(", ")')"
  fi
}

# -------------------------------------------------------------------
# 1. Health check
# -------------------------------------------------------------------
log "Checking health..."
HEALTH=$(curl -sf "$BASE_URL/health" 2>&1) || { fail "Health check — server not reachable at $BASE_URL"; exit 1; }
assert_contains "$HEALTH" '"status":"ok"' "Health endpoint returns ok"

# -------------------------------------------------------------------
# 2. Register sample tools
# -------------------------------------------------------------------
log "Registering tools..."
REG_RESPONSE=$(curl -sf -X POST "$BASE_URL/api/v1/tools" \
  -H "Content-Type: application/json" \
  -d '{
    "tools": [
      {
        "name": "getAccountInfo",
        "description": "Get customer account details including name, email, and plan"
      },
      {
        "name": "processRefund",
        "description": "Process a refund for a specific invoice or purchase"
      },
      {
        "name": "getInvoices",
        "description": "List invoices and billing history for a customer account"
      },
      {
        "name": "resetPassword",
        "description": "Reset user password and send a recovery email"
      },
      {
        "name": "runDiagnostics",
        "description": "Run diagnostics on a service, check for errors and outages"
      },
      {
        "name": "checkServiceStatus",
        "description": "Check the current status of API services and uptime"
      },
      {
        "name": "updateBillingInfo",
        "description": "Update payment method or billing address for an account"
      },
      {
        "name": "sendNotification",
        "description": "Send a push notification or email to a user"
      }
    ]
  }')
assert_contains "$REG_RESPONSE" '"registered":8' "Registered 8 tools"

# -------------------------------------------------------------------
# 3. List tools
# -------------------------------------------------------------------
log "Listing tools..."
LIST_RESPONSE=$(curl -sf "$BASE_URL/api/v1/tools")
TOOL_COUNT=$(echo "$LIST_RESPONSE" | jq '.tools | length')
if [ "$TOOL_COUNT" -eq 8 ]; then
  pass "GET /api/v1/tools returns 8 tools"
else
  fail "GET /api/v1/tools — expected 8 tools, got $TOOL_COUNT"
fi

# -------------------------------------------------------------------
# 4. Discover — test scenarios from PRD
# -------------------------------------------------------------------
discover() {
  curl -sf -X POST "$BASE_URL/api/v1/discover" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$1\", \"limit\": $2}"
}

log "Testing discover: 'I want a refund'"
R1=$(discover "I want a refund for my last purchase" 5)
assert_top_tool "$R1" "processRefund" "Refund query → processRefund top"
assert_in_top_n "$R1" "getInvoices" 3 "Refund query → getInvoices in top 3"

log "Testing discover: 'Reset my password'"
R2=$(discover "Reset my password" 5)
assert_top_tool "$R2" "resetPassword" "Password query → resetPassword top"
assert_in_top_n "$R2" "getAccountInfo" 3 "Password query → getAccountInfo in top 3"

log "Testing discover: 'API is returning 401 errors'"
R3=$(discover "API is returning 401 errors" 5)
assert_in_top_n "$R3" "runDiagnostics" 2 "401 errors → runDiagnostics in top 2"
assert_in_top_n "$R3" "checkServiceStatus" 2 "401 errors → checkServiceStatus in top 2"

log "Testing discover: 'Update my credit card'"
R4=$(discover "Update my credit card on file" 5)
assert_top_tool "$R4" "updateBillingInfo" "Credit card query → updateBillingInfo top"

log "Testing discover: limit parameter"
R5=$(discover "help me" 2)
RETURNED=$(echo "$R5" | jq '.tools | length')
if [ "$RETURNED" -le 2 ]; then
  pass "Limit=2 returns at most 2 tools (got $RETURNED)"
else
  fail "Limit=2 returned $RETURNED tools"
fi

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo ""
echo "========================================="
echo -e "  Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC} / ${TOTAL} total"
echo "========================================="

[ "$FAILED" -eq 0 ] && exit 0 || exit 1
