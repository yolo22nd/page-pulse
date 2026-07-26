import request from 'supertest';
import http from 'http';
import { AddressInfo } from 'net';
import app from '../src/app';
import { setupTestRedis, teardownTestRedis } from './helpers/redisTestHelper';

describe('Audit Engine Correctness & Contract Shape (POST /api/audit)', () => {
  let server: http.Server;
  let serverUrl: string;

  beforeAll((done) => {
    setupTestRedis().then(() => {
      server = http.createServer((req, res) => {
      const urlPath = req.url || '/';

      if (urlPath === '/full-audit') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>PagePulse Audit Test</title>
              <meta name="description" content="Audit test page description" />
              <link rel="canonical" href="${serverUrl}/full-audit" />
              <meta name="robots" content="index, follow" />
              <link rel="stylesheet" href="/styles.css" />
            </head>
            <body>
              <h1>Primary Title Heading</h1>
              <p>Sample content</p>
              <a href="/healthy-link">Healthy Link</a>
              <a href="/broken-link">Broken Link</a>
              <script src="/script.js"></script>
            </body>
          </html>
        `);
      } else if (urlPath === '/healthy-link') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
      } else if (urlPath === '/broken-link') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      } else if (urlPath === '/hanging-target') {
        // Hang connection to test hard timeout ceiling enforcement
        setTimeout(() => {
          if (!res.headersSent) {
            res.writeHead(200);
            res.end('Late');
          }
        }, 5000);
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

  it('should return complete response contract shape matching Zod schema', async () => {
    const targetUrl = `${serverUrl}/full-audit`;
    const res = await request(app).post('/api/audit').send({
      url: targetUrl,
      timeoutMs: 10000,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;
    expect(data.url).toBe(targetUrl);
    expect(typeof data.auditedAt).toBe('string');
    expect(typeof data.overallScore).toBe('number');
    expect(data.overallScore).toBeGreaterThanOrEqual(0);
    expect(data.overallScore).toBeLessThanOrEqual(100);

    // HTTP
    expect(data.http.statusCode).toBe(200);
    expect(typeof data.http.responseTimeMs).toBe('number');
    expect(Array.isArray(data.http.redirectChain)).toBe(true);

    // SSL (null for HTTP target)
    expect(data.ssl).toBeNull();

    // SEO
    expect(data.seo).toEqual({
      title: 'PagePulse Audit Test',
      metaDescription: 'Audit test page description',
      canonicalUrl: `${serverUrl}/full-audit`,
      h1Count: 1,
      firstH1: 'Primary Title Heading',
      metaRobots: 'index, follow',
    });

    // Broken Links
    expect(data.brokenLinks.checkedCount).toBe(2);
    expect(data.brokenLinks.brokenCount).toBe(1);
    expect(data.brokenLinks.skippedCount).toBe(0);
    expect(data.brokenLinks.brokenLinks).toEqual([
      {
        url: `${serverUrl}/broken-link`,
        statusCode: 404,
        error: 'HTTP status 404',
      },
    ]);

    // Performance Heuristic
    expect(typeof data.performance.htmlSizeBytes).toBe('number');
    expect(data.performance.scriptTagCount).toBe(1);
    expect(data.performance.cssTagCount).toBe(1);
    expect(typeof data.performance.score).toBe('number');

    // Metadata
    expect(data.cached).toBe(false);
    expect(data.cacheAge).toBeNull();
  });

  it('should enforce hard timeout ceiling on hanging upstream target and return 504 AUDIT_TIMEOUT', async () => {
    const startTime = Date.now();
    const res = await request(app).post('/api/audit').send({
      url: `${serverUrl}/hanging-target`,
      timeoutMs: 1000,
    });
    const duration = Date.now() - startTime;

    expect(res.status).toBe(504);
    expect(res.body.error).toEqual({
      code: 'AUDIT_TIMEOUT',
      message: 'Audit operation timed out after 1000ms',
    });

    // Assert terminated around configured timeoutMs (1000ms - 2500ms ceiling)
    expect(duration).toBeGreaterThanOrEqual(950);
    expect(duration).toBeLessThan(3000);
  });
});
