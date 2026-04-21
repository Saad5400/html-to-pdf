#!/usr/bin/env bash
# Bring up everything you need to play with html-to-pdf locally:
#   - Redis (Docker)
#   - API server (foreground)
#   - Worker (background)
#   - Open the playground in your default browser
#
# Stop with Ctrl-C (cleans up worker + redis automatically).
set -euo pipefail

cd "$(dirname "$0")/.."

API_KEY="${API_KEY:-dev-key-change-me}"
PORT="${PORT:-3000}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_NAME="htp-redis-local"

cleanup() {
  echo
  echo "[local] cleaning up..."
  [[ -n "${WORKER_PID:-}" ]] && kill "$WORKER_PID" 2>/dev/null || true
  docker rm -f "$REDIS_NAME" >/dev/null 2>&1 || true
  exit 0
}
trap cleanup INT TERM

echo "[local] starting redis container ($REDIS_NAME on :$REDIS_PORT)..."
docker rm -f "$REDIS_NAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$REDIS_NAME" -p "${REDIS_PORT}:6379" redis:7-alpine >/dev/null

# Wait for redis to be ready.
for i in {1..20}; do
  if docker exec "$REDIS_NAME" redis-cli ping 2>/dev/null | grep -q PONG; then break; fi
  sleep 0.25
done

# Make sure Chromium is installed.
if ! npx playwright --version >/dev/null 2>&1; then
  echo "[local] installing Playwright..."
  npm install --no-audit --no-fund --ignore-scripts >/dev/null
fi
if ! ls "${HOME}/.cache/ms-playwright/chromium-"* >/dev/null 2>&1; then
  echo "[local] installing Chromium..."
  npx playwright install chromium >/dev/null
fi

export REDIS_URL="redis://localhost:${REDIS_PORT}"
export API_KEYS="$API_KEY"
export PORT
export LOG_LEVEL="${LOG_LEVEL:-info}"
export BROWSER_POOL_SIZE="${BROWSER_POOL_SIZE:-2}"

echo "[local] starting worker (background)..."
npx tsx src/worker/index.ts > /tmp/htp-worker.log 2>&1 &
WORKER_PID=$!

echo "[local] starting API server on http://localhost:${PORT}"
echo "[local] API key:      ${API_KEY}"
echo "[local] Playground:   http://localhost:${PORT}/playground"
echo "[local] Swagger UI:   http://localhost:${PORT}/docs"
echo "[local] Worker log:   /tmp/htp-worker.log"
echo

# Open the playground in the user's browser, best-effort.
( sleep 2 && {
    URL="http://localhost:${PORT}/playground"
    if command -v xdg-open >/dev/null; then xdg-open "$URL" >/dev/null 2>&1 || true
    elif command -v open      >/dev/null; then open      "$URL" >/dev/null 2>&1 || true
    fi
  }
) &

exec npx tsx src/server.ts
