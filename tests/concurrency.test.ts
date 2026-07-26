import express, { Express, Request, Response } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import {
  concurrencyLimiter,
  getActiveAuditsCount,
  resetActiveAuditsCount,
} from '../src/middleware/concurrencyLimiter';
import { errorHandler } from '../src/middleware/errorHandler';

describe('Concurrency Protection & Capacity Release', () => {
  let testApp: Express;
  let testServer: http.Server;
  let serverUrl: string;
  let slowResolvers: Array<() => void> = [];
  const originalEnvMax = process.env.MAX_CONCURRENT_AUDITS;

  beforeAll((done) => {
    testApp = express();
    testApp.use(express.json());

    // Slow audit endpoint holding connection until explicitly released
    testApp.post('/audit-slow', concurrencyLimiter, async (_req: Request, res: Response) => {
      await new Promise<void>((resolve) => {
        slowResolvers.push(resolve);
      });
      res.status(200).json({ status: 'completed' });
    });

    testApp.use(errorHandler);

    testServer = http.createServer(testApp);
    testServer.listen(0, '127.0.0.1', () => {
      const address = testServer.address() as AddressInfo;
      serverUrl = `http://127.0.0.1:${address.port}`;
      done();
    });
  });

  afterAll((done) => {
    testServer.close(done);
  });

  beforeEach(() => {
    resetActiveAuditsCount();
    slowResolvers = [];
    process.env.MAX_CONCURRENT_AUDITS = '2'; // Set low limit for concurrency testing
  });

  afterEach(() => {
    process.env.MAX_CONCURRENT_AUDITS = originalEnvMax;
    slowResolvers.forEach((resolve) => resolve());
    slowResolvers = [];
  });

  it('should reject excess concurrent requests with 503 while in-flight requests proceed and release slots afterward', async () => {
    expect(getActiveAuditsCount()).toBe(0);

    // 1. Dispatch 5 requests genuinely concurrently via Promise.all
    const requestPromises = Array.from({ length: 5 }).map(() =>
      fetch(`${serverUrl}/audit-slow`, { method: 'POST' }),
    );

    // Small delay to allow HTTP requests to reach Express middleware
    await new Promise((r) => setTimeout(r, 60));

    // Verify 2 slots are occupied and 3 requests were rejected
    expect(getActiveAuditsCount()).toBe(2);

    // Resolve in-flight requests
    slowResolvers.forEach((resolve) => resolve());

    const responses = await Promise.all(requestPromises);
    const statusCodes = responses.map((r) => r.status).sort();

    // Exactly 2 requests succeeded (200), and 3 requests were rejected immediately (503)
    expect(statusCodes).toEqual([200, 200, 503, 503, 503]);

    // Verify error shape of 503 response
    const rejectedResponse = responses.find((r) => r.status === 503);
    expect(rejectedResponse).toBeDefined();
    if (rejectedResponse) {
      const body = await rejectedResponse.json();
      expect(body).toEqual({
        error: {
          code: 'CONCURRENCY_LIMIT_EXCEEDED',
          message: 'Concurrency limit of 2 in-flight audits reached. Please retry later.',
        },
      });
    }

    // Capacity must free up back to 0
    expect(getActiveAuditsCount()).toBe(0);
  });
});
