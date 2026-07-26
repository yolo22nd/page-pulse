import request from 'supertest';
import app from '../src/app';
import { setupTestRedis, teardownTestRedis } from './helpers/redisTestHelper';

describe('Input Validation (POST /api/audit)', () => {
  beforeAll(async () => {
    await setupTestRedis();
  });

  afterAll(async () => {
    await teardownTestRedis();
  });
  it('should accept valid HTTP and HTTPS URLs', async () => {
    const resHttp = await request(app).post('/api/audit').send({
      url: 'http://127.0.0.1:59999',
    });
    // Validation passes (fails at fetch stage with 502, not 400)
    expect(resHttp.status).not.toBe(400);

    const resHttps = await request(app).post('/api/audit').send({
      url: 'https://127.0.0.1:59999',
    });
    expect(resHttps.status).not.toBe(400);
  });

  it('should return 400 VALIDATION_ERROR if url field is missing', async () => {
    const res = await request(app).post('/api/audit').send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error.code', 'VALIDATION_ERROR');
    expect(res.body).toHaveProperty('error.message', 'Invalid request parameters');
    expect(res.body).toHaveProperty('error.details');
  });

  it('should return 400 VALIDATION_ERROR if url is malformed or invalid format', async () => {
    const res = await request(app).post('/api/audit').send({
      url: 'not-a-valid-url-string',
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error.code', 'VALIDATION_ERROR');
  });

  it('should return 400 VALIDATION_ERROR if scheme is not http or https', async () => {
    const res = await request(app).post('/api/audit').send({
      url: 'ftp://files.example.com/archive.zip',
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error.code', 'VALIDATION_ERROR');
  });

  it('should return 400 VALIDATION_ERROR if timeoutMs is below 1000ms', async () => {
    const res = await request(app).post('/api/audit').send({
      url: 'http://example.com',
      timeoutMs: 500,
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error.code', 'VALIDATION_ERROR');
  });

  it('should return 400 VALIDATION_ERROR if timeoutMs exceeds 30000ms', async () => {
    const res = await request(app).post('/api/audit').send({
      url: 'http://example.com',
      timeoutMs: 40000,
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error.code', 'VALIDATION_ERROR');
  });
});
