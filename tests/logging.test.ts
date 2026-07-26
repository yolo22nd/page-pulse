import request from 'supertest';
import app from '../src/app';
import { setupTestRedis, teardownTestRedis } from './helpers/redisTestHelper';

describe('Structured JSON Logging & X-Request-Id Propagation', () => {
  beforeEach(async () => {
    await setupTestRedis();
  });

  afterEach(async () => {
    await teardownTestRedis();
  });

  it('should include X-Request-Id response header on health check requests', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers).toHaveProperty('x-request-id');
    expect(typeof res.headers['x-request-id']).toBe('string');
    expect(res.headers['x-request-id'].length).toBeGreaterThan(0);
  });

  it('should preserve and echo custom incoming X-Request-Id header in response headers', async () => {
    const customRequestId = 'req-custom-test-uuid-12345';

    const res = await request(app)
      .get('/health')
      .set('X-Request-Id', customRequestId);

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe(customRequestId);
  });

  it('should include X-Request-Id response header on audit requests', async () => {
    const res = await request(app)
      .post('/api/audit')
      .send({ url: 'http://example.com' });

    expect(res.headers).toHaveProperty('x-request-id');
  });
});
