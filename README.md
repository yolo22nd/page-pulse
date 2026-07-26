# PagePulse — URL Audit Engine & API

PagePulse is a production-grade, asynchronous URL audit API built with Express, TypeScript, Zod, and Pino. It performs real-time server-side webpage audits computing HTTP status and redirect chain analysis (up to 5 redirects), SSL certificate validity and expiration tracking, SEO metadata extraction (title, meta description, canonical link, H1 tags, meta robots), 20-link broken link checking with bounded concurrency, and static HTML/CSS/JS performance heuristics. Engineered for high-throughput reliability, PagePulse features hand-rolled in-memory concurrency control, per-client IP rate limiting (`express-rate-limit` + `rate-limit-redis`), and Redis cache-aside acceleration (`ioredis`) with automatic fail-open resilience.

---

## Live Deployed Service

- **Live Service Base URL**: [https://page-pulse-dkgh.onrender.com](https://page-pulse-dkgh.onrender.com)
- **Status & Docs Landing Page**: `GET /` ([https://page-pulse-dkgh.onrender.com/](https://page-pulse-dkgh.onrender.com/))
- **Health Check Endpoint**: `GET /health` ([https://page-pulse-dkgh.onrender.com/health](https://page-pulse-dkgh.onrender.com/health))

---

## Full API Contract

### Endpoint
`POST /api/audit`

### Request Body Schema (Zod Validated)

| Field | Type | Required | Default | Constraints / Validation |
|---|---|---|---|---|
| `url` | `string` | **Yes** | — | Must be a valid HTTP or HTTPS URL (e.g. `https://example.com`) |
| `timeoutMs` | `number` | No | `10000` | Integer, min `1000` ms, max `30000` ms |
| `forceRefresh` | `boolean` | No | `false` | When `true`, bypasses Redis cache read but writes fresh result back to cache |

#### Example Request JSON Body
```json
{
  "url": "https://example.com",
  "timeoutMs": 10000,
  "forceRefresh": false
}
```

---

### Response Schemas

#### 1. Success Response (`200 OK`)
Envelope: `{ "success": true, "data": { ... } }`

| Field | Type | Description |
|---|---|---|
| `url` | `string` | Audited target URL |
| `auditedAt` | `string` | ISO 8601 UTC timestamp of audit execution |
| `overallScore` | `number` | Weighted score from 0 to 100 based on HTTP, SSL, SEO, links, and performance |
| `http` | `object` | `{ statusCode: number, responseTimeMs: number, redirectChain: string[] }` (capped at 5 redirects) |
| `ssl` | `object \| null` | `{ isValid: boolean, issuer: string, daysUntilExpiry: number }` (null for `http://` targets) |
| `seo` | `object` | `{ title: string \| null, metaDescription: string \| null, canonicalUrl: string \| null, h1Count: number, firstH1: string \| null, metaRobots: string \| null }` |
| `brokenLinks` | `object` | `{ checkedCount: number, brokenCount: number, skippedCount: number, brokenLinks: Array<{ url: string, statusCode: number \| null, error: string \| null }> }` (max 20 checked) |
| `performance` | `object` | `{ htmlSizeBytes: number, scriptTagCount: number, cssTagCount: number, score: number }` |
| `errors` | `string[]` | Array of non-fatal execution warning/error strings encountered during sub-checks |
| `cached` | `boolean` | `true` if response was served from Redis cache; `false` otherwise |
| `cacheAge` | `number \| null` | Age of cached result in seconds if `cached: true`; `null` otherwise |

#### 2. Error Response (`400`, `429`, `503`, `504`)
Envelope: `{ "error": { "code": string, "message": string, "details"?: any } }`

| Error Code | HTTP Status | Trigger Condition |
|---|---|---|
| `VALIDATION_ERROR` | `400 Bad Request` | Missing `url`, invalid URL format, or `timeoutMs` out of range |
| `UPSTREAM_FETCH_ERROR` | `400 Bad Request` | Upstream target domain unreachable, DNS failure, or connection refused |
| `REDIRECT_LIMIT_EXCEEDED` | `400 Bad Request` | Upstream HTTP redirect chain exceeded max 5 redirects ceiling |
| `AUDIT_TIMEOUT` | `504 Gateway Timeout` | Audit operation exceeded requested `timeoutMs` threshold |
| `CONCURRENCY_LIMIT_EXCEEDED` | `503 Service Unavailable` | Maximum in-flight audit limit reached (`MAX_CONCURRENT_AUDITS`, default 10) |
| `RATE_LIMIT_EXCEEDED` | `429 Too Many Requests` | IP rate limit exceeded (`RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS`) |
| `INTERNAL_SERVER_ERROR` | `500 Internal Server Error` | Unexpected internal server exception |

---

### Example `curl` Invocations & Responses

#### Example 1: Audit Request Execution
```bash
curl -i -X POST https://page-pulse-dkgh.onrender.com/api/audit \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

##### Example Success JSON Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "url": "https://example.com",
    "auditedAt": "2026-07-26T19:18:37.859Z",
    "overallScore": 88,
    "http": {
      "statusCode": 200,
      "responseTimeMs": 209,
      "redirectChain": []
    },
    "ssl": {
      "isValid": true,
      "issuer": "SSL Corporation",
      "daysUntilExpiry": 34
    },
    "seo": {
      "title": "Example Domain",
      "metaDescription": null,
      "canonicalUrl": null,
      "h1Count": 1,
      "firstH1": "Example Domain",
      "metaRobots": null
    },
    "brokenLinks": {
      "checkedCount": 1,
      "brokenCount": 0,
      "skippedCount": 0,
      "brokenLinks": []
    },
    "performance": {
      "htmlSizeBytes": 559,
      "scriptTagCount": 0,
      "cssTagCount": 0,
      "score": 100
    },
    "errors": [],
    "cached": false,
    "cacheAge": null
  }
}
```

#### Example 2: Validation Error (`400 Bad Request`)
```bash
curl -i -X POST https://page-pulse-dkgh.onrender.com/api/audit \
  -H "Content-Type: application/json" \
  -d '{"url": "not-a-valid-url"}'
```
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request parameters",
    "details": [
      {
        "field": "url",
        "message": "Must be a valid HTTP or HTTPS URL"
      }
    ]
  }
}
```

---

## Environment Variables

| Variable Name | Purpose / Description | Default Value | Production Setting |
|---|---|---|---|
| `PORT` | HTTP web server port | `3000` | Assigned by Render (e.g. `10000`) |
| `NODE_ENV` | Application execution environment | `development` | `production` |
| `REDIS_URL` | Redis connection URL for caching and rate-limiting store | `redis://127.0.0.1:6379` | Render Redis addon internal URL (`redis://red-...:6379`) |
| `MAX_CONCURRENT_AUDITS` | Maximum allowable in-flight audit requests before returning 503 | `10` | `10` |
| `AUDIT_CACHE_TTL_SECONDS` | Time-To-Live (TTL) in seconds for successful audit results cached in Redis | `300` | `300` (5 minutes) |
| `RATE_LIMIT_WINDOW_MS` | Per-client IP rate limit window duration in milliseconds | `60000` | `60000` (1 minute) |
| `RATE_LIMIT_MAX_REQUESTS` | Maximum allowed audit requests per IP within the rate limit window | `20` | `20` |

---

## How to Run Locally

### Prerequisites
- Node.js `v20.0.0` or higher
- Docker installed and running locally

### 1. Start Local Redis Container
Run a local Redis container listening on port `6379`:
```bash
docker run -d --name redis-local -p 6379:6379 redis:7-alpine
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Start Development Server
Start the development server with live watch/reloading (`tsx`):
```bash
npm run dev
```
The service will start at `http://localhost:3000`.

### 4. Build & Run Production Output Locally
Compile TypeScript to JavaScript and start the production Express server:
```bash
npm run build
npm start
```

---

## Testing & CI Pipeline

### Local Testing
Run the complete Jest integration test suite (29 tests across 9 test suites):
```bash
npm test
```
*Note: If local Redis is running on `127.0.0.1:6379`, tests run against real Redis. If Redis is offline, tests gracefully fall back to `ioredis-mock`.*

### Code Quality & Typechecking
```bash
npm run lint         # Runs ESLint static analysis
npx tsc --noEmit     # Performs strict TypeScript typecheck
```

### GitHub Actions Continuous Integration (CI)
The service features a GitHub Actions CI pipeline configured in `.github/workflows/ci.yml`:
- **Triggers**: Executed on every `push` to `main` and `pull_request` targeting `main`.
- **Redis Container**: Automatically provisions a Docker `redis:7-alpine` service container listening on port `6379` for full integration testing.
- **Pipeline Steps**:
  1. Checks out repository (`actions/checkout@v4`)
  2. Sets up Node.js 20 environment with npm caching (`actions/setup-node@v4`)
  3. Installs dependencies (`npm ci`)
  4. Runs ESLint static analysis (`npm run lint`)
  5. Runs TypeScript typecheck (`npx tsc --noEmit`)
  6. Executes complete Jest test suite (`npm test`) with `REDIS_URL: redis://127.0.0.1:6379`
  7. Compiles production build bundle (`npm run build`)

---

## Known Limitations & Infrastructure Tradeoffs

### Render Free-Tier Idle Spin-Down & Cold Starts
PagePulse is deployed on Render's Free Instance Tier:
- **Spin-Down Behavior**: Free web services automatically spin down (sleep) after **15 minutes of inactivity**.
- **Cold Start Latency**: When an incoming HTTP request hits the sleeping service, Render automatically boots up the container. This causes an initial **30–60 second cold-start delay** on the first request. Subsequent requests within the active window respond instantly (< 50ms for cached results).
- **Design Tradeoff Rationale**: For a demonstration and assessment service, Render's free web tier paired with the free Render Redis addon provides a zero-cost, persistent infrastructure deployment with real Redis integration.

---

## Technical Documentation & Architecture Decisions

For complete design rationale, architecture documentation, decision records, and task list breakdowns for Task B, refer to the [`docs`](./docs) directory:
- [Technical Architecture & Task B Documentation](./docs)
