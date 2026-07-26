import request from 'supertest';
import RedisMock from 'ioredis-mock';
import app from '../src/app';
import { setRedisClient } from '../src/lib/redis';
import * as auditEngine from '../src/lib/audit';

describe('Redis Cache-Aside Caching (POST /api/audit)', () => {
  let mockRedis: InstanceType<typeof RedisMock>;
  let runAuditSpy: jest.SpyInstance;

  beforeEach(() => {
    mockRedis = new RedisMock();
    setRedisClient(mockRedis as unknown as import('ioredis').default);
    process.env.AUDIT_CACHE_TTL_SECONDS = '300';

    runAuditSpy = jest.spyOn(auditEngine, 'runAudit').mockImplementation(async (options) => {
      return {
        url: options.url,
        auditedAt: new Date().toISOString(),
        overallScore: 85,
        http: {
          statusCode: 200,
          responseTimeMs: 120,
          redirectChain: [],
        },
        ssl: null,
        seo: {
          title: 'Mock Title',
          metaDescription: 'Mock Description',
          canonicalUrl: options.url,
          h1Count: 1,
          firstH1: 'Heading',
          metaRobots: 'index, follow',
        },
        brokenLinks: {
          checkedCount: 0,
          brokenCount: 0,
          skippedCount: 0,
          brokenLinks: [],
        },
        performance: {
          htmlSizeBytes: 500,
          scriptTagCount: 1,
          cssTagCount: 1,
          score: 90,
        },
        errors: [],
        cached: false,
        cacheAge: null,
      };
    });
  });

  afterEach(() => {
    runAuditSpy.mockRestore();
    setRedisClient(null);
  });

  it('(1) second identical request within TTL returns cached result and skips audit execution', async () => {
    const targetUrl = 'http://example.com/page';

    // 1st Request (Cache Miss)
    const res1 = await request(app).post('/api/audit').send({ url: targetUrl });
    expect(res1.status).toBe(200);
    expect(res1.body.data.cached).toBe(false);
    expect(res1.body.data.cacheAge).toBeNull();
    expect(runAuditSpy).toHaveBeenCalledTimes(1);

    // 2nd Identical Request (Cache Hit)
    const res2 = await request(app).post('/api/audit').send({ url: targetUrl });
    expect(res2.status).toBe(200);
    expect(res2.body.data.cached).toBe(true);
    expect(typeof res2.body.data.cacheAge).toBe('number');
    expect(res2.body.data.cacheAge).toBeGreaterThanOrEqual(0);

    // Crucial requirement: runAudit execution count MUST still be 1
    expect(runAuditSpy).toHaveBeenCalledTimes(1);
  });

  it('(2) request after TTL expiry re-fetches the target', async () => {
    const targetUrl = 'http://example.com/ttl-test';

    // 1st Request
    await request(app).post('/api/audit').send({ url: targetUrl });
    expect(runAuditSpy).toHaveBeenCalledTimes(1);

    // Clear cache entry to simulate TTL expiration
    await mockRedis.flushall();

    // 2nd Request after TTL expiry
    const res2 = await request(app).post('/api/audit').send({ url: targetUrl });
    expect(res2.status).toBe(200);
    expect(res2.body.data.cached).toBe(false);

    // Audit engine must be invoked a 2nd time
    expect(runAuditSpy).toHaveBeenCalledTimes(2);
  });

  it('(3) forceRefresh=true always re-fetches regardless of cache state', async () => {
    const targetUrl = 'http://example.com/force-refresh';

    // 1st Request (Populate cache)
    await request(app).post('/api/audit').send({ url: targetUrl });
    expect(runAuditSpy).toHaveBeenCalledTimes(1);

    // 2nd Request with forceRefresh: true
    const res2 = await request(app).post('/api/audit').send({
      url: targetUrl,
      forceRefresh: true,
    });

    expect(res2.status).toBe(200);
    expect(res2.body.data.cached).toBe(false);

    // Audit engine must be invoked again despite valid cache entry
    expect(runAuditSpy).toHaveBeenCalledTimes(2);
  });

  it('normalizes URLs so different parameter order and trailing slashes hit the same cache', async () => {
    const rawUrl1 = 'http://EXAMPLE.com/path/?b=2&a=1';
    const rawUrl2 = 'http://example.com/path?a=1&b=2';

    // 1st Request with rawUrl1
    await request(app).post('/api/audit').send({ url: rawUrl1 });
    expect(runAuditSpy).toHaveBeenCalledTimes(1);

    // 2nd Request with rawUrl2 (normalized equivalent)
    const res2 = await request(app).post('/api/audit').send({ url: rawUrl2 });
    expect(res2.status).toBe(200);
    expect(res2.body.data.cached).toBe(true);

    // Should be a cache hit (0 extra audit calls)
    expect(runAuditSpy).toHaveBeenCalledTimes(1);
  });

  it('fails open when Redis operations throw errors', async () => {
    // Mock Redis throwing errors on GET and SET
    const errorRedis = {
      get: jest.fn().mockRejectedValue(new Error('Redis connection refused')),
      set: jest.fn().mockRejectedValue(new Error('Redis connection refused')),
      ttl: jest.fn().mockRejectedValue(new Error('Redis connection error')),
      call: jest.fn().mockImplementation((cmd: string) => {
        const cmdLower = cmd.toLowerCase();
        if (cmdLower === 'script') {
          return Promise.resolve('mock_sha_hash');
        }
        if (cmdLower === 'eval' || cmdLower === 'evalsha') {
          return Promise.resolve([1, 60000]);
        }
        return Promise.reject(new Error('Redis connection error'));
      }),
      eval: jest.fn().mockResolvedValue([1, 60000]),
    };
    setRedisClient(errorRedis as unknown as import('ioredis').default);

    const res = await request(app).post('/api/audit').send({
      url: 'http://example.com/fail-open',
    });

    // Request must still succeed with 200 OK
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.cached).toBe(false);
    expect(runAuditSpy).toHaveBeenCalledTimes(1);
  });
});
