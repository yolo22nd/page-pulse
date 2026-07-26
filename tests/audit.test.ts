import request from 'supertest';
import http from 'http';
import { AddressInfo } from 'net';
import app from '../src/app';

describe('POST /api/audit API Contract & Audit Engine', () => {
  let server: http.Server;
  let serverUrl: string;

  beforeAll((done) => {
    // Spin up an in-memory HTTP server for deterministic audit testing
    server = http.createServer((req, res) => {
      const urlPath = req.url || '/';

      if (urlPath === '/simple') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Test Page Title</title>
              <meta name="description" content="A test page description" />
              <link rel="canonical" href="${serverUrl}/simple" />
              <meta name="robots" content="index, follow" />
              <link rel="stylesheet" href="/style.css" />
            </head>
            <body>
              <h1>Main Heading 1</h1>
              <p>Welcome to test page</p>
              <a href="/healthy-link">Healthy Link</a>
              <a href="/broken-link">Broken Link</a>
              <script src="/app.js"></script>
            </body>
          </html>
        `);
      } else if (urlPath === '/healthy-link') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
      } else if (urlPath === '/broken-link') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      } else if (urlPath === '/slow') {
        // Delay response to trigger audit timeout
        setTimeout(() => {
          if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Slow Response</h1>');
          }
        }, 3000);
      } else if (urlPath.startsWith('/redirect-')) {
        const step = parseInt(urlPath.replace('/redirect-', ''), 10);
        if (step < 7) {
          res.writeHead(302, { Location: `/redirect-${step + 1}` });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>Final Redirect Destination</h1>');
        }
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

  afterAll((done) => {
    server.close(done);
  });

  describe('Validation Errors (400 VALIDATION_ERROR)', () => {
    it('should return 400 if url is missing', async () => {
      const res = await request(app).post('/api/audit').send({});

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error.code', 'VALIDATION_ERROR');
      expect(res.body).toHaveProperty('error.details');
    });

    it('should return 400 if url format is invalid', async () => {
      const res = await request(app).post('/api/audit').send({
        url: 'invalid-url-string',
      });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error.code', 'VALIDATION_ERROR');
    });

    it('should return 400 if url scheme is not http/https', async () => {
      const res = await request(app).post('/api/audit').send({
        url: 'ftp://example.com/file',
      });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error.code', 'VALIDATION_ERROR');
    });

    it('should return 400 if timeoutMs is out of allowed range', async () => {
      const resTooLow = await request(app).post('/api/audit').send({
        url: 'http://example.com',
        timeoutMs: 500, // min is 1000
      });
      expect(resTooLow.status).toBe(400);

      const resTooHigh = await request(app).post('/api/audit').send({
        url: 'http://example.com',
        timeoutMs: 50000, // max is 30000
      });
      expect(resTooHigh.status).toBe(400);
    });
  });

  describe('Upstream & Timeout Errors (502 / 504)', () => {
    it('should return 502 UPSTREAM_FETCH_ERROR if host is unreachable', async () => {
      const res = await request(app).post('/api/audit').send({
        url: 'http://127.0.0.1:59999', // Closed port
        timeoutMs: 3000,
      });

      expect(res.status).toBe(502);
      expect(res.body).toHaveProperty('error.code', 'UPSTREAM_FETCH_ERROR');
    });

    it('should return 502 REDIRECT_LIMIT_EXCEEDED if redirects exceed 5', async () => {
      const res = await request(app).post('/api/audit').send({
        url: `${serverUrl}/redirect-1`,
        timeoutMs: 5000,
      });

      expect(res.status).toBe(502);
      expect(res.body).toHaveProperty('error.code', 'REDIRECT_LIMIT_EXCEEDED');
    });

    it('should return 504 AUDIT_TIMEOUT if audit operation exceeds timeoutMs', async () => {
      const res = await request(app).post('/api/audit').send({
        url: `${serverUrl}/slow`,
        timeoutMs: 1000,
      });

      expect(res.status).toBe(504);
      expect(res.body).toHaveProperty('error.code', 'AUDIT_TIMEOUT');
    });
  });

  describe('Successful Audit Execution (200 OK)', () => {
    it('should perform a full audit and return structured metrics', async () => {
      const targetUrl = `${serverUrl}/simple`;
      const res = await request(app).post('/api/audit').send({
        url: targetUrl,
        timeoutMs: 10000,
      });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);

      const data = res.body.data;
      expect(data).toHaveProperty('url', targetUrl);
      expect(data).toHaveProperty('auditedAt');
      expect(typeof data.overallScore).toBe('number');
      expect(data.overallScore).toBeGreaterThanOrEqual(0);
      expect(data.overallScore).toBeLessThanOrEqual(100);

      // 1. HTTP Audit
      expect(data.http).toEqual({
        statusCode: 200,
        responseTimeMs: expect.any(Number),
        redirectChain: [],
      });

      // 2. SSL Audit (null for http target)
      expect(data.ssl).toBeNull();

      // 3. SEO Audit
      expect(data.seo).toEqual({
        title: 'Test Page Title',
        metaDescription: 'A test page description',
        canonicalUrl: `${serverUrl}/simple`,
        h1Count: 1,
        firstH1: 'Main Heading 1',
        metaRobots: 'index, follow',
      });

      // 4. Broken Links Audit
      expect(data.brokenLinks).toEqual({
        checkedCount: 2,
        brokenCount: 1,
        skippedCount: 0,
        brokenLinks: [
          {
            url: `${serverUrl}/broken-link`,
            statusCode: 404,
            error: 'HTTP status 404',
          },
        ],
      });

      // 5. Performance Heuristic Audit
      expect(data.performance).toHaveProperty('htmlSizeBytes');
      expect(data.performance).toHaveProperty('scriptTagCount', 1);
      expect(data.performance).toHaveProperty('cssTagCount', 1);
      expect(data.performance.score).toBeGreaterThanOrEqual(0);
    });
  });
});
