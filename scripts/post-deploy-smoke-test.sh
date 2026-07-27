#!/usr/bin/env bash
set -euo pipefail

LIVE_URL="${1:-https://page-pulse-dkgh.onrender.com}"
echo "Running post-deploy smoke tests against ${LIVE_URL}..."

# 1. Verify Health Check
HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${LIVE_URL}/health")
if [ "$HEALTH_STATUS" -ne 200 ]; then
  echo "FAIL: Health check returned ${HEALTH_STATUS}"
  exit 1
fi

# 2. Verify Landing Page
LANDING_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${LIVE_URL}/")
if [ "$LANDING_STATUS" -ne 200 ]; then
  echo "FAIL: Landing page returned ${LANDING_STATUS}"
  exit 1
fi

# 3. Verify Live Audit Endpoint Execution & Request ID Header
AUDIT_RESP=$(curl -s -i -X POST "${LIVE_URL}/api/audit" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}')

if ! echo "$AUDIT_RESP" | grep -qi "x-request-id:"; then
  echo "FAIL: Missing X-Request-Id header on response"
  exit 1
fi

if ! echo "$AUDIT_RESP" | grep -q '"success":true'; then
  echo "FAIL: Audit endpoint did not return success payload"
  exit 1
fi

echo "SUCCESS: All post-deploy smoke tests passed cleanly!"
