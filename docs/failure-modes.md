# Failure Mode Analysis & Operational Risk — PagePulse

This document details the three most likely failure modes for **PagePulse** when scaling to **10,000 audits/day** with **500-concurrent request bursts**. Grounded in empirical observations from Task A's deployment, each scenario outlines the observed symptoms/metrics, technical mitigation, and honest residual risk.

---

## 1. Failure Mode 1: Cold-Start & Spin-Down Latency Spikes Under SLA

### Context & Empirical Baseline
In Task A, PagePulse was deployed on Render's free tier. As documented, free-tier instances automatically spin down to 0 replicas after **15 minutes of inactivity**, incurring an observed cold-start wake-up latency of **30 to 60 seconds** on the next incoming request.

While acceptable for a non-critical demo, at **10,000 audits/day** with a customer-facing response SLA (sub-50ms cache hit, sub-5s fresh audit), a 500-request burst hitting a sleeping or cold service causes systemic failure:
- The HTTP load balancer attempts to route 500 simultaneous TCP connections to a container that is not yet ready to accept traffic.
- The Linux kernel TCP backlog queue (`somaxconn`) overflows, dropping excess SYN packets.
- Ingress API Gateways (Cloudflare / AWS ALB) reach their upstream read timeout ceiling (~30s) and drop the client connections with **`504 Gateway Timeout`**.

### Observed Symptoms & Metrics
- **Client-Side Errors**: HTTP status code **`504 Gateway Timeout`** or `ECONNRESET` on client connections.
- **Latency Metrics**: P99 response time spikes to **30,000 ms – 60,000 ms**.
- **APM Metrics**: `http_requests_total{status="504"}` rate spikes sharply; container CPU/RAM utilization metrics show 0% during idle periods followed by a vertical spike during boot up.
- **Logs**: Ingress gateway logs emit `upstream timed out (110: Connection timed out) while connecting to upstream`.

### Technical Mitigation Strategy
1. **Provisioned Minimum Instance Baseline**: Transition from Render free-tier idle spin-down to paid production container hosting (e.g. AWS ECS / Render Individual Plan) configured with a **minimum replica count of 3 warm containers** across multiple Availability Zones.
2. **Active Synthetic Warmth Probing**: Implement a light background cron service issuing `GET /health` requests every 60 seconds to guarantee container readiness and pre-warmed TCP connection pools.
3. **HTTP Keep-Alive & Connection Pooling**: Configure load balancer keep-alive timeouts (`keepAliveTimeout: 65000`) exceeding cloud load balancer idle timeouts to keep persistent TCP channels open between the gateway and Web API nodes.

### Honest Residual Risk
- **Autoscaling Reaction Lag**: While provisioned warm instances handle baseline load, a sudden step-function burst jumping from 5 QPS to 500 QPS within seconds will temporarily exceed the capacity of 3 instances. Cloud autoscalers (AWS Target Tracking / Render AutoScale) require **15 to 45 seconds** to launch and register new container tasks. During this brief scaling window, un-cached audit requests will experience queue delay or trigger backpressure rejection (`503 Service Unavailable`).

---

## 2. Failure Mode 2: Redis Memory Exhaustion & Eviction Thrashing

### Context & Mathematical Sizing Math

Task A deployed a single Redis addon instance on Render's **25MB free tier**.

#### Analysis of Data Streams & Accumulation:
1. **TTL-Bounded Streams (Non-Accumulating)**:
   - **Audit Cache Payloads**: Bounded by `AUDIT_CACHE_TTL_SECONDS=300` (5 minutes). At 10,000 audits/day with a 30% unique rate during peak hours, active cache entries peak at ~10 entries $\times$ 2.5 KB $\approx$ **25 KB**.
   - **Rate Limit Counters**: Bounded by 60s window (`RATE_LIMIT_WINDOW_MS=60000`), consuming transient memory of **< 10 KB**.
2. **Unbounded Accumulator (BullMQ Job Metadata)**:
   - In Task B's async queueing architecture, every incoming audit creates a persistent BullMQ job hash tracking job status (waiting, active, completed, failed), arguments, and execution logs.
   - BullMQ job metadata hash size: **~1.5 KB per job**.
   - Redis key dict & index overhead: **~0.5 KB per key**.
   - Total overhead per job entry: **~2.0 KB per job**.

#### Daily Accumulation & Memory Demand:
$$\text{Daily Job Metadata Accumulation} = 10,000 \text{ jobs/day} \times 2.0 \text{ KB/job} = 20,000 \text{ KB/day} \approx \mathbf{20 \text{ MB/day}}$$

**Conclusion**: On Task A's 25MB free-tier Redis instance, if BullMQ job pruning (`removeOnComplete`, `removeOnFail`) is unconfigured, job state metadata accumulates at 20 MB/day. Memory will be **100% exhausted within ~30 hours** of continuous operation ($\frac{25 \text{ MB}}{20 \text{ MB/day}} \approx 1.25 \text{ days}$). Without explicit configuration, Redis will return **`OOM command not allowed when used memory > 'maxmemory'`**. Task A's code handles this via fail-open logging (`Redis cache write error`), but caching and queueing fail completely.

### Observed Symptoms & Metrics
- **Log Errors**: Pino warning logs emitting `Redis connection refused` or `Redis cache write error (failing open)`.
- **Cache Hit Ratio**: `cache_hit_ratio` metric collapses from ~70% to **< 5%**.
- **System Metrics**: `redis_memory_used_bytes` hits `25,000,000` (100% capacity); `redis_evicted_keys_total` spikes vertically.
- **Upstream Latency**: Database and worker load double because every incoming request becomes a cache miss.

### Technical Mitigation Strategy
1. **Infrastructure Tier Upgrade**: Upgrade to a **1GB Managed Redis Cluster** (AWS ElastiCache / Redis Cloud) with automatic memory alerts at 75% capacity.
2. **Explicit Memory Eviction Policy**: Set Redis `maxmemory-policy` to **`allkeys-lru`** (Least Recently Used). If memory limit is reached during a traffic spike, Redis automatically purges the oldest cached audit responses without throwing OOM errors or interrupting rate-limit counters.
3. **Aggressive TTL Management & Job Pruning**: Enforce strict 300s TTLs (`AUDIT_CACHE_TTL_SECONDS=300`) on cache entries, and configure BullMQ to auto-remove completed/failed job records after 1 hour (`removeOnComplete: { age: 3600 }`).

### Honest Residual Risk
- **Cache Thrashing Under High URL Cardinality**: If a burst of 500 concurrent requests contains 500 completely unique URLs, the high cardinality will rapidly evict older, frequently requested cached entries. This causes **eviction thrashing**, temporarily reducing overall cache efficiency until the burst subsides.

---

## 3. Failure Mode 3: Downstream Target-Site Slowness ("Noisy Neighbor" Worker Starvation)

### Context & Failure Mechanism
PagePulse worker containers execute outbound HTTP/SSL/SEO audits against arbitrary third-party web servers. 

Under a 500-concurrent request burst, if 50 requests target slow or misconfigured third-party websites (e.g. servers holding HTTP connections open, tarpitting requests, or taking 15 seconds to return headers), worker threads spend the majority of their lifecycle waiting on socket read timeouts (`AUDIT_TIMEOUT`).

Because worker thread pools have finite concurrency (e.g. 10 worker threads per container across 10 containers = 100 max concurrent active audits), **50 slow target sites will consume 50% of the entire system's worker capacity**. Fast-responding audit requests queued behind them are starved of worker slots, causing system-wide latency inflation.

### Observed Symptoms & Metrics
- **Worker Saturation Metric**: `worker_pool_active_jobs` reaches **100% saturation**.
- **Queue Depth**: `queue_waiting_jobs_count` grows monotonically (e.g., rising from 10 to > 1,500 pending jobs).
- **Client Impact**: Un-cached audit requests experience high queue wait times before execution begins, risking client HTTP timeouts.
- **Log Signatures**: Accumulation of `AUDIT_TIMEOUT` warning logs in worker streams.

### Technical Mitigation Strategy
1. **Per-Domain Worker Concurrency Caps**: Restrict workers from executing more than **2 concurrent audits per target domain host**. Additional requests for the same domain are delayed in BullMQ, preventing a single slow target website from hogging worker threads.
2. **Strict Operation Timeouts**: Maintain Task A's hard operation timeout ceiling (`AUDIT_TIMEOUT`, default 8000ms) enforced via `AbortController` across all sub-checks (`ssl.ts`, `seo.ts`, `links.ts`).
3. **Short-Circuit Broken Link Timeouts**: Cap individual broken-link HTTP checks to **2,000ms max per link** (checking up to 20 links in parallel with `Promise.all`).

### Honest Residual Risk
- **Distributed Slow-Target Attack / High Domain Variance**: If a client submits 500 requests targeting 500 *distinct* slow websites, per-domain concurrency caps will not trigger. Worker capacity will still saturate for the duration of `AUDIT_TIMEOUT` (8s), forcing the system's Layer-2 backpressure valve to issue **`503 Service Unavailable`** to subsequent incoming requests until workers free up.

---

## 4. Operational Mitigation & Failure Summary Matrix

| Failure Mode | Trigger / Cause | Primary Observed Symptom | Technical Mitigation | Residual Risk |
|---|---|---|---|---|
| **Cold-Start Latency** | Idle instance spin-down (Render free tier) | `504 Gateway Timeout` & 30–60s P99 latency spikes | 3+ provisioned warm containers + active health pinging | Auto-scaler 15–45s lag during sudden 0-to-500 QPS spikes |
| **Redis OOM Exhaustion** | 25MB free tier saturation from unpruned BullMQ job state at 10k/day | `OOM command not allowed` logs & 0% cache hit ratio | 1GB+ Managed Redis Cluster + `allkeys-lru` eviction + BullMQ job pruning | Cache thrashing under high-cardinality unique URL bursts |
| **Worker Starvation** | Slow target websites holding sockets open | Worker pool 100% saturated & queue depth backlog | Per-domain worker caps + hard 8s `AUDIT_TIMEOUT` | Distributed slow targets across 500 distinct domains |
