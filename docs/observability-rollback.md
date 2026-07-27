# Observability & Rollback Plan — PagePulse

This document outlines the operational monitoring strategy, predictive SLA alerting rules, post-deploy verification procedures, and concrete rollback mechanisms for **PagePulse**.

---

## 1. Observability Architecture & Telemetry Stack

PagePulse's observability stack evolves between Task A and Task B:

- **Currently Live (Task A Baseline)**:
  1. **Structured JSON Logs**: Emitted by `pino` and `pino-http` to stdout, correlated globally across all requests via `X-Request-Id`.
  2. **Automated Smoke Testing**: Post-deploy verification executed via `scripts/post-deploy-smoke-test.sh` against the live endpoint.
- **Proposed Target Architecture (Task B Scale-Up)**:
  1. **Prometheus Metrics Stream**: Proposed `/metrics` endpoint (using `prom-client` or OpenTelemetry exporter) exposing operational metrics for Prometheus/Datadog scraping.
  2. **Distributed Tracing**: Context propagation (`traceparent` HTTP headers) across Load Balancer $\rightarrow$ API Gateway $\rightarrow$ BullMQ Queue $\rightarrow$ Worker Tier.

---

## 2. Telemetry & Core Metrics to Monitor (Proposed Task B Metric Specifications)

### A. Traffic & Request Rate Metrics
- `http_requests_total{method, route, status}`: Total HTTP request counter grouped by endpoint (`GET /`, `GET /health`, `POST /api/audit`) and status code.

### B. Error Rate Breakdown by Category
- `audit_errors_total{code}`: Counter tracking audit failures by Zod error code:
  - `VALIDATION_ERROR` (HTTP 400 - Client invalid input)
  - `RATE_LIMIT_EXCEEDED` (HTTP 429 - Per-client IP quota exhausted)
  - `CONCURRENCY_LIMIT_EXCEEDED` (HTTP 503 - Immediate capacity cap)
  - `AUDIT_TIMEOUT` (HTTP 504 - Upstream page fetch or link check timeout)
  - `UPSTREAM_FETCH_ERROR` (HTTP 502 - Third-party target site network/DNS failure)
  - `INTERNAL_SERVER_ERROR` (HTTP 500 - System exceptions)

### C. Latency Percentiles (P50, P95, P99)
- `audit_request_duration_ms_bucket{cached="true|false"}`: Histogram tracking audit completion latency. Latency is explicitly split into:
  - **Cache Hits**: Sub-50ms expectation.
  - **Fresh Audits**: Sub-3,000ms target expectation.

### D. Queue Health & Backpressure Metrics
- `queue_waiting_jobs_count`: Gauge tracking current pending BullMQ jobs.
- `queue_oldest_job_age_seconds`: Gauge tracking the age of the longest-waiting pending audit job in seconds.

### E. Cache & Redis Tier Metrics
- `cache_hit_ratio`: Calculated ratio of $(\text{cache\_hits} / \text{total\_audit\_requests})$.
- `redis_used_memory_bytes`: Gauge tracking active Redis RAM utilization against maxmemory.
- `redis_evicted_keys_total`: Counter tracking key evictions under LRU policy.

### F. Infrastructure & Container Lifecycle
- `container_restarts_total`: Counter tracking process crashes and container restarts.
- `container_boot_duration_ms`: Latency metric measuring cold-start boot duration (referencing Task A's observed 30–60s Render free-tier baseline).

### G. Per-Target-Site Failure Rate
- `audit_target_failures_total{domain}`: Aggregate metric tracking failure rates grouped by third-party target host domain (e.g. `example.com`), used to identify target-side WAF blocking or outage patterns.

---

## 3. SLA Definitions & Predictive Alerting Rules

### Assumed SLA Benchmarks
For PagePulse operating at 10,000 audits/day:
- **Cache Hit Latency SLA**: P99 **< 50 ms**.
- **Fresh Audit Latency SLA**: P95 **< 3,000 ms** (under normal load).
- **Service Availability SLA**: **99.9%** success rate for valid non-4xx requests over a rolling 30-day window.

### Predictive / Leading Indicator Alerts (Alerting BEFORE SLA Breach)

To prevent SLA violations, PagePulse fires predictive alerts based on leading velocity metrics:

```
[ Metric Stream ] ──► Queue Growth Rate > 50 jobs/sec? ──► [ Alert: Queue Velocity Spike ]
                  ──► Redis Memory > 75% Capacity?      ──► [ Alert: Redis Eviction Risk ]
                  ──► Worker Saturation > 85%?          ──► [ Alert: Worker Capacity Warning ]
```

#### Alert 1: Queue Backlog Velocity Spike (Leading SLA Indicator)
- **Condition**: `rate(queue_waiting_jobs_count[1m]) > 50` for **> 2 minutes**.
- **Rationale**: Signals that burst ingestion is outpacing worker processing speed. Fires *before* the 3,000ms P95 latency SLA is violated, giving autoscalers time to spin up additional worker containers.
- **Severity**: `WARNING` (Triggers worker auto-scale expansion).

#### Alert 2: Redis Memory Near-Capacity Warning (Leading Eviction Indicator)
- **Condition**: `(redis_used_memory_bytes / redis_maxmemory_bytes) > 0.75` for **> 3 minutes**.
- **Rationale**: Warns operators when memory reaches 75% capacity, allowing scale-up before LRU key evictions purge active cache entries.
- **Severity**: `WARNING`.

#### Alert 3: Worker Pool Capacity Saturation
- **Condition**: `(worker_pool_active_jobs / worker_pool_max_capacity) > 0.85` for **> 3 minutes**.
- **Rationale**: Indicates worker pool is operating near maximum concurrency limit, signaling impending backpressure rejection.
- **Severity**: `WARNING`.

### Reactive SLA Breach Alerts

#### Alert 4: Fresh Audit P95 Latency SLA Breach
- **Condition**: `histogram_quantile(0.95, rate(audit_request_duration_ms_bucket{cached="false"}[5m])) > 3000` for **> 5 minutes**.
- **Severity**: `CRITICAL` (Pagers operational team).

#### Alert 5: High HTTP 5xx Error Rate
- **Condition**: `(sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))) > 0.01` for **> 3 minutes**.
- **Severity**: `CRITICAL` (Triggers automated rollback evaluation).

---

## 4. Deploy Verification & Post-Deploy Smoke Testing

Every deployment to Render / AWS invokes an automated post-deploy verification script (`scripts/post-deploy-smoke-test.sh`) before marking the deployment healthy:

```bash
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
```

---

## 5. Concrete Rollback Protocols

### Automated Rollback Trigger Conditions
An immediate rollback is automatically initiated if:
1. Post-deploy smoke test script fails with a non-zero exit code.
2. HTTP 5xx error rate exceeds **2.0%** within 5 minutes of a new deployment.
3. Container restart counter `container_restarts_total` increments > 5 times in 3 minutes post-deploy.

### Primary Rollback Procedure — Render Infrastructure CLI & Dashboard

Render maintains a complete immutable deployment history keyed by deploy ID (e.g. `dep-d9j5orn1dkcs73bnbbvg`).

#### CLI Execution Steps:
1. Identify the previous known-good deployment ID via Render CLI:
   ```bash
   render deploys list --service-id srv-d9j5orn1dkcs73bnbbvg --limit 5
   ```
2. Roll back to the previous deployment ID instantly:
   ```bash
   render deploys create --service-id srv-d9j5orn1dkcs73bnbbvg --from-deploy dep-previous-good-id
   ```
3. Verify live service health post-rollback:
   ```bash
   ./scripts/post-deploy-smoke-test.sh https://page-pulse-dkgh.onrender.com
   ```

#### Dashboard UI Execution:
- Navigate to Service `page-pulse` (`srv-d9j5orn1dkcs73bnbbvg`) $\rightarrow$ **Events & Deploys** $\rightarrow$ Locate previous successful deploy $\rightarrow$ Click **"Rollback to this deploy"**.

### Secondary Fallback Procedure — Git Revert & CI/CD Push

If cloud-provider deploy history is inaccessible:

1. Revert the target release commit on `main`:
   ```bash
   git fetch origin main
   git checkout main
   git revert HEAD -m "revert: rollback failed production deployment"
   ```
2. Push directly to `main` to trigger GitHub Actions CI and Render automated deployment:
   ```bash
   git push origin main
   ```
3. Watch GitHub Actions workflow completion:
   ```bash
   gh run watch $(gh run list --limit 1 --json databaseId -q '.[0].databaseId')
   ```
