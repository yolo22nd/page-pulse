import request from 'supertest';
import app from '../src/app';
import { setupTestRedis, teardownTestRedis } from './helpers/redisTestHelper';
import * as auditEngine from '../src/lib/audit';

describe('Per-Client IP Rate Limiting (POST /api/audit)', () => {
  let runAuditSpy: jest.SpyInstance;
  const originalMax = process.env.RATE_LIMIT_MAX_REQUESTS;
  const originalWindow = process.env.RATE_LIMIT_WINDOW_MS;

  beforeEach(async () => {
    await setupTestRedis();

    runAuditSpy = jest.spyOn(auditEngine, 'runAudit').mockImplementation(async (options) => {
      return {
        url: options.url,
        auditedAt: new Date().toISOString(),
        overallScore: 80,
        http: { statusCode: 200, responseTimeMs: 100, redirectChain: [] },
        ssl: null,
        seo: {
          title: 'Title',
          metaDescription: 'Desc',
          canonicalUrl: options.url,
          h1Count: 1,
          firstH1: 'H1',
          metaRobots: 'index',
        },
        brokenLinks: { checkedCount: 0, brokenCount: 0, skippedCount: 0, brokenLinks: [] },
        performance: { htmlSizeBytes: 400, scriptTagCount: 1, cssTagCount: 1, score: 85 },
        errors: [],
        cached: false,
        cacheAge: null,
      };
    });
  });

  afterEach(async () => {
    runAuditSpy.mockRestore();
    await teardownTestRedis();
    process.env.RATE_LIMIT_MAX_REQUESTS = originalMax;
    process.env.RATE_LIMIT_WINDOW_MS = originalWindow;
  });

  it('should enforce rate limit and return 429 when max requests threshold is exceeded', async () => {
    process.env.RATE_LIMIT_MAX_REQUESTS = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';

    const clientIp = '203.0.113.195';

    // 3 requests within threshold
    for (let i = 1; i <= 3; i++) {
      const res = await request(app)
        .post('/api/audit')
        .set('X-Forwarded-For', clientIp)
        .send({ url: 'http://example.com' });
      expect(res.status).toBe(200);
    }

    // 4th request exceeds threshold -> HTTP 429
    const res4 = await request(app)
      .post('/api/audit')
      .set('X-Forwarded-For', clientIp)
      .send({ url: 'http://example.com' });

    expect(res4.status).toBe(429);
    expect(res4.headers).toHaveProperty('retry-after');
    expect(res4.body).toEqual({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many audit requests from this IP. Please try again later.',
      },
    });
  });

  it('should reset rate limit quota after window duration expires', async () => {
    process.env.RATE_LIMIT_MAX_REQUESTS = '2';
    process.env.RATE_LIMIT_WINDOW_MS = '1000'; // 1 second short test window

    const clientIp = '203.0.113.196';

    // 2 requests fill quota
    for (let i = 1; i <= 2; i++) {
      const res = await request(app)
        .post('/api/audit')
        .set('X-Forwarded-For', clientIp)
        .send({ url: 'http://example.com' });
      expect(res.status).toBe(200);
    }

    // Immediate 3rd request -> HTTP 429
    const resBlocked = await request(app)
      .post('/api/audit')
      .set('X-Forwarded-For', clientIp)
      .send({ url: 'http://example.com' });
    expect(resBlocked.status).toBe(429);

    // Wait 1100ms for short 1s window to expire
    await new Promise((r) => setTimeout(r, 1100));

    // Request after window expiration -> HTTP 200
    const resAfterExpiry = await request(app)
      .post('/api/audit')
      .set('X-Forwarded-For', clientIp)
      .send({ url: 'http://example.com' });
    expect(resAfterExpiry.status).toBe(200);
  });

  it('should NOT rate limit GET /health endpoint even if audit limit is reached', async () => {
    process.env.RATE_LIMIT_MAX_REQUESTS = '1';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';

    const clientIp = '203.0.113.197';

    // Exhaust audit quota
    await request(app)
      .post('/api/audit')
      .set('X-Forwarded-For', clientIp)
      .send({ url: 'http://example.com' });

    // Subsequent audit request blocked
    const resAudit = await request(app)
      .post('/api/audit')
      .set('X-Forwarded-For', clientIp)
      .send({ url: 'http://example.com' });
    expect(resAudit.status).toBe(429);

    // GET /health must remain accessible
    const resHealth = await request(app)
      .get('/health')
      .set('X-Forwarded-For', clientIp);
    expect(resHealth.status).toBe(200);
    expect(resHealth.body.status).toBe('ok');
  });

  it('should track rate limits independently per client IP via trust proxy', async () => {
    process.env.RATE_LIMIT_MAX_REQUESTS = '1';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';

    const clientA = '198.51.100.1';
    const clientB = '198.51.100.2';

    // Client A exhausts quota
    await request(app)
      .post('/api/audit')
      .set('X-Forwarded-For', clientA)
      .send({ url: 'http://example.com' });

    // Client A blocked
    const resA = await request(app)
      .post('/api/audit')
      .set('X-Forwarded-For', clientA)
      .send({ url: 'http://example.com' });
    expect(resA.status).toBe(429);

    // Client B still has full quota
    const resB = await request(app)
      .post('/api/audit')
      .set('X-Forwarded-For', clientB)
      .send({ url: 'http://example.com' });
    expect(resB.status).toBe(200);
  });
});
