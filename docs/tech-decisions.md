# Technology Decision Record (TDR) — PagePulse

This document records the key architectural and technology decisions made for **PagePulse**. It covers both the **Task A** initial implementation choices (optimized for a single-engineer take-home demonstration context) and the **Task B** scaling decisions required to support **10,000 audits/day** with **500 concurrent request bursts**.

---

## 1. Operational Context & Evaluation Principles

All technical choices in PagePulse were evaluated against explicit system constraints rather than generic industry dogma:

- **Task A Constraints**: Single engineer (team of 1), zero-cost budget constraint (Render free tier), fast iteration, high testability, and visible, inspectable reasoning in code.
- **Task B Constraints**: High availability (99.9%), 500-concurrent request burst spikes, sub-50ms cache read SLA, 95% sub-5s audit SLA, and bounded infrastructure costs.

---

## 2. Task A Architecture Decisions

### Decision 1: Application Framework — Express.js
- **Decision**: Built the HTTP service using **Express.js** (`express`) with TypeScript.
- **Rejected Alternative**: **Fastify**.
- **Reasoning**: While Fastify offers a faster HTTP router implementation (~20–30% higher raw QPS in synthetic benchmarks), Express was selected because:
  1. For PagePulse, the performance bottleneck is outbound web network I/O and DOM parsing, not HTTP router CPU overhead.
  2. Express provides 100% seamless compatibility with standard middleware ecosystem packages (`pino-http`, `express-rate-limit`).
  3. Team-of-one simplicity: zero configuration overhead and predictable execution during evaluation.
- **Task A vs. Task B Reality**: Express remains perfectly suitable for Task B's Web Tier when horizontally autoscaled behind an API Gateway/Load Balancer.

---

### Decision 2: Request Validation & Schema Management — Zod
- **Decision**: Enforced request body validation using **Zod** (`zod`).
- **Rejected Alternative**: **Joi** / **Ajv (JSON Schema)**.
- **Reasoning**:
  1. Zod provides static TypeScript type inference (`zod.infer<typeof Schema>`) directly from runtime schemas, guaranteeing zero type drift between validation code and application logic.
  2. Joi requires separate TypeScript interface declarations, creating maintenance duplication. Ajv requires a build step for JSON schema compilation.
- **Task A vs. Task B Reality**: Zod scales effortlessly to Task B without modification; schemas defined in `src/schemas/audit.schema.ts` are shared cleanly across Web and Worker tiers.

---

### Decision 3: Structured Logging — Pino & pino-http
- **Decision**: Implemented structured JSON logging using **Pino** (`pino` and `pino-http`).
- **Rejected Alternative**: **Winston** + **Morgan**.
- **Reasoning**:
  1. Pino is an order of magnitude faster than Winston because it minimizes event loop blocking during JSON stringification.
  2. `pino-http` automatically handles request context correlation, generating or propagating `X-Request-Id` response headers across log lines seamlessly.
  3. Natively supports `pino-pretty` formatting during local development (`NODE_ENV=development`).
- **Task A vs. Task B Reality**: Standard JSON output to stdout in production allows log aggregators (Datadog / CloudWatch) to ingest and index Task B logs without code modifications.

---

### Decision 4: Per-Client IP Rate Limiting — express-rate-limit + rate-limit-redis
- **Decision**: Configured per-client rate limiting via `express-rate-limit` using `rate-limit-redis` as the store.
- **Rejected Alternative**: **Hand-rolled Redis sliding-window Lua script** or **Cloudflare WAF Rate Limiting**.
- **Reasoning**:
  1. `rate-limit-redis` offloads counter state to Redis using Lua scripts, guaranteeing atomic sliding-window checks across requests.
  2. Integrates directly with Express's `app.set('trust proxy', 1)` to extract client IP from `X-Forwarded-For` behind reverse proxies like Render/Cloudflare.
  3. Cloudflare WAF was rejected for Task A because it requires domain DNS control, which is outside the scope of a local/demo repository.
- **Task A vs. Task B Reality**: In Task B, initial rate limiting moves to the API Gateway / WAF level to block malicious traffic before hitting application containers, while `rate-limit-redis` serves as a secondary defense layer.

---

### Decision 5: Concurrency Control — Hand-Rolled In-Memory Counter Middleware
- **Decision**: Implemented an in-memory counter middleware (`src/middleware/concurrencyLimiter.ts`) enforcing `MAX_CONCURRENT_AUDITS` (default 10).
- **Rejected Alternative**: **`p-limit` / `p-queue`** or **Redis Distributed Semaphore**.
- **Reasoning**:
  1. A hand-rolled counter using Express response events (`res.once('finish')`, `res.once('close')`) explicitly guarantees that decrements fire under every termination path (success, validation error, upstream fetch failure, or client disconnect/abort).
  2. `p-limit` operates on promises inside handler functions, making it harder to handle early HTTP response aborts cleanly at the middleware boundary.
- **Task A vs. Task B Reality**: **This is the single biggest architectural difference between Task A and Task B.** An in-memory counter only works on a single Render instance. In Task B's multi-instance scaled architecture, concurrency control transitions to a BullMQ job queue depth limit.

---

### Decision 6: Caching Strategy & Redis Client — ioredis Cache-Aside
- **Decision**: Implemented cache-aside caching via `ioredis` (`src/lib/cache.ts`) with custom URL normalization (`src/lib/urlNormalizer.ts`).
- **Rejected Alternative**: **`node-redis`** or **In-Memory LRU Cache (`lru-cache`)**.
- **Reasoning**:
  1. `ioredis` provides reliable auto-reconnect defaults, native promise APIs, and script evaluation needed for Redis operations.
  2. In-memory JS process caching (`lru-cache`) fails in a multi-instance or serverless setup because cache state is fragmented per container.
  3. `ioredis` enabled implementing **fail-open resilience**: if Redis crashes, PagePulse logs a warning and proceeds with fresh audits rather than failing client requests.
- **Task A vs. Task B Reality**: The cache-aside code structure remains unchanged in Task B, but the underlying Redis infrastructure scales up in memory tier.

---

### Decision 7: Testing Framework — Jest + Supertest
- **Decision**: Built the test suite using **Jest** and **Supertest**.
- **Rejected Alternative**: **Vitest** or **Mocha + Chai**.
- **Reasoning**:
  1. Jest provides an all-in-one runner with integrated assertion libraries, mock timers (`jest.spyOn`), and coverage reporting without third-party plugins.
  2. Supertest allows executing HTTP requests directly against Express's `app` instance without spinning up real network sockets during unit testing.
- **Task A vs. Task B Reality**: Jest remains the standard unit/integration runner, complemented by k6 load testing scripts for Task B performance validation.

---

### Decision 8: Initial Infrastructure & Deployment Target — Render Free Tier + Render Redis
- **Decision**: Deployed the Web Service and Redis Addon on **Render's Free Tier**.
- **Rejected Alternative**: **AWS ECS / Fargate** or **Vercel Serverless**.
- **Reasoning**:
  1. Render provides a free persistent Node.js web service environment paired with a free Redis instance.
  2. Vercel Serverless was rejected because serverless functions have strict execution timeouts (10–15s max) and cannot support background processing loops or persistent in-memory counters.
  3. AWS ECS was rejected for Task A due to monthly infrastructure cost and deployment overhead for a demonstration project.
- **Task A vs. Task B Reality**: Optimized for zero-cost demo evaluation. Task B requires upgrading Render/AWS resources to paid tier instances to eliminate free-tier spin-down sleep.

---

## 3. Task B Scale-Up Decisions

### Decision 9: Queue Technology — BullMQ on Redis
- **Decision**: Adopt **BullMQ** for asynchronous job queueing.
- **Rejected Alternative**: **AWS SQS** or **RabbitMQ**.
- **Reasoning**:
  1. BullMQ runs directly on top of the existing Redis infrastructure, avoiding the operational complexity of managing a separate RabbitMQ cluster.
  2. SQS lacks native atomic job deduplication by payload hash; BullMQ natively supports unique `jobId` deduplication based on normalized URL hashes.
  3. SQS has higher latency for short-lived tasks (~10–20ms polling overhead vs. sub-millisecond Redis streams).

---

### Decision 10: Redis Infrastructure & Eviction Strategy — 1GB+ Managed Redis Cluster with `allkeys-lru`
- **Decision**: Upgrade Redis from Task A's 25MB free tier to a **1GB+ Managed Redis Cluster** (AWS ElastiCache or Redis Cloud) configured with `allkeys-lru` eviction policy.
- **Rejected Alternative**: **Task A 25MB Free Tier** or **Serverless Redis (Upstash)**.
- **Reasoning**:
  1. At 10,000 audits/day with ~2.5KB audit payloads, 24-hour cache retention requires ~25MB active memory, but peak burst index overhead and rate-limiting keys require headroom.
  2. Setting `allkeys-lru` guarantees that under 500-request spikes, if memory limit is approached, Redis automatically evicts the oldest cached audits without throwing `OOM` memory errors or interrupting active rate-limiting counters.

---

### Decision 11: Application Tier — Horizontally Scaled Stateless API + Worker Pool Separation
- **Decision**: Separate the monolith into two container roles:
  1. **Stateless Web API Containers**: Horizontally autoscaled (min 3 instances) to validate requests, check Redis cache, and return immediate `200 OK` or `202 Accepted`.
  2. **Dedicated Background Worker Containers**: Scaled independently based on queue depth to execute outbound HTTP/SSL/SEO audits.
- **Rejected Alternative**: **Single-instance monolith with Node.js worker threads**.
- **Reasoning**:
  1. Running heavy outbound audits in the same container process as the web API causes event loop lag and degrades response times for cache hits.
  2. Physical separation allows scaling web containers on HTTP QPS while scaling worker containers on Queue Depth.

---

### Decision 12: Ingress & Traffic Control — Cloudflare / AWS ALB + Layer-2 Queue Backpressure
- **Decision**: Place API containers behind an API Gateway / Load Balancer enforcing **Layer-2 Queue Depth Backpressure** (`503 Service Unavailable` + `Retry-After: 30` when queue depth exceeds 2,000 pending jobs).
- **Rejected Alternative**: **Unbounded Ingress Buffering**.
- **Reasoning**:
  1. Unbounded queues lead to memory exhaustion and stale audits (jobs waiting 10+ minutes in queue fail SLA requirements).
  2. Returning structured `503` with `Retry-After` signals clients to pause requests during extreme burst events, preserving system stability.

---

## 4. Summary Matrix of Decisions

| Architectural Area | Task A Choice (Demo Context) | Task B Choice (Production Scale) | Primary Driver |
|---|---|---|---|
| **Framework** | Express + TypeScript | Express (Autoscaled) | Developer velocity & middleware ecosystem |
| **Validation** | Zod | Zod (Shared schemas) | End-to-end type safety |
| **Logging** | Pino + pino-http | Pino + Centralized Log Aggregator | Low serialization overhead & `X-Request-Id` |
| **Rate Limiting** | `express-rate-limit` + Redis | API Gateway + `rate-limit-redis` | Multi-layer protection |
| **Concurrency** | Hand-rolled in-memory counter | BullMQ Queue Depth | Single-instance vs. Distributed cluster |
| **Caching Client** | `ioredis` (Fail-open) | `ioredis` + Redis Cluster (`allkeys-lru`) | Memory safety during burst traffic |
| **Queue Tech** | N/A (Sync execution) | BullMQ on Redis | Atomic transitions & job deduplication |
| **Hosting Infrastructure** | Render Free Tier (Spin-down) | Render Paid / AWS ECS + ElastiCache | SLA guarantees & zero cold-starts |
