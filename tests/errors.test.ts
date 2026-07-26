import request from 'supertest';
import http from 'http';
import { AddressInfo } from 'net';
import app from '../src/app';
import { setupTestRedis, teardownTestRedis } from './helpers/redisTestHelper';

describe('Error Handling & Edge Cases (POST /api/audit)', () => {
  let server: http.Server;
  let serverUrl: string;

  beforeAll((done) => {
    setupTestRedis().then(() => {
      server = http.createServer((req, res) => {
        const urlPath = req.url || '/';

        if (urlPath === '/json-api') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Not an HTML page' }));
        } else if (urlPath.startsWith('/redirect-loop-')) {
          const step = parseInt(urlPath.replace('/redirect-loop-', ''), 10);
          res.writeHead(302, { Location: `/redirect-loop-${step + 1}` });
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        serverUrl = `http://127.0.0.1:${address.port}`;
        done();
      });
    });
  });

  afterAll(async () => {
    await teardownTestRedis();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('should return 502 UPSTREAM_FETCH_ERROR when host is unreachable', async () => {
    const res = await request(app).post('/api/audit').send({
      url: 'http://127.0.0.1:59998', // Closed port
      timeoutMs: 3000,
    });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_FETCH_ERROR');
    expect(res.body.error.message).toContain('Unable to fetch URL');
  });

  it('should return 502 REDIRECT_LIMIT_EXCEEDED when redirects exceed 5', async () => {
    const res = await request(app).post('/api/audit').send({
      url: `${serverUrl}/redirect-loop-1`,
      timeoutMs: 5000,
    });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('REDIRECT_LIMIT_EXCEEDED');
    expect(res.body.error.message).toContain('Exceeded maximum redirect limit');
  });

  it('should handle non-HTML response gracefully without crashing', async () => {
    const res = await request(app).post('/api/audit').send({
      url: `${serverUrl}/json-api`,
      timeoutMs: 5000,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.seo).toEqual({
      title: null,
      metaDescription: null,
      canonicalUrl: null,
      h1Count: 0,
      firstH1: null,
      metaRobots: null,
    });
  });
});
