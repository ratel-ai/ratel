#!/usr/bin/env bash
# Usage: OPENAI_API_KEY=sk-... ./scripts/e2e.sh
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Source .env if present
if [ -f "$REPO_ROOT/.env" ]; then
  set -a && source "$REPO_ROOT/.env" && set +a
fi

cleanup() {
  echo -e "\n${YELLOW}▶${NC} Tearing down containers..."
  docker compose -f "$REPO_ROOT/docker-compose.yml" down --timeout 5 2>/dev/null || true
}
trap cleanup EXIT

# 1. Validate env
if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo -e "${RED}ERROR:${NC} OPENAI_API_KEY is not set. Export it and retry."
  exit 1
fi

# 2. Build & start
echo -e "${YELLOW}▶${NC} Building and starting containers..."
docker compose -f "$REPO_ROOT/docker-compose.yml" up -d --build

# 3. Wait for health
echo -e "${YELLOW}▶${NC} Waiting for server health..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:9119/health >/dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Server healthy after ${i}s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo -e "${RED}✗${NC} Server failed to start within 30s"
    docker compose -f "$REPO_ROOT/docker-compose.yml" logs
    exit 1
  fi
  sleep 1
done

# 4. Curl-based tests
echo -e "\n${YELLOW}▶${NC} Running curl tests..."
AGENTIFIED_URL=http://localhost:9119 bash "$REPO_ROOT/scripts/test-server.sh"

# 5. SDK integration tests
echo -e "\n${YELLOW}▶${NC} Running SDK integration tests..."
cd "$REPO_ROOT/packages/sdk"
AGENTIFIED_TEST_URL=http://localhost:9119 npx vitest run src/__tests__/integration.test.ts

echo -e "\n${GREEN}✓${NC} All e2e tests passed!"
