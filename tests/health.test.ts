import request from 'supertest';
import app from '../src/app';
import { setupTestRedis, teardownTestRedis } from './helpers/redisTestHelper';

describe('GET /health', () => {
  beforeAll(async () => {
    await setupTestRedis();
  });

  afterAll(async () => {
    await teardownTestRedis();
  });
  it('should return 200 OK with health details', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'ok');
    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('uptime');
  });
});
