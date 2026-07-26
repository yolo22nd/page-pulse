import request from 'supertest';
import express, { Express, Request, Response } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import {
  concurrencyLimiter,
  getActiveAuditsCount,
  resetActiveAuditsCount,
} from '../src/middleware/concurrencyLimiter';
import { errorHandler } from '../src/middleware/errorHandler';

describe('Hand-Rolled Concurrency-Limiting Middleware', () => {
  let testApp: Express;
  let testServer: http.Server;
  let serverUrl: string;
  let slowResolvers: Array<() => void> = [];
  const originalEnvMax = process.env.MAX_CONCURRENT_AUDITS;

  beforeAll((done) => {
    testApp = express();
    testApp.use(express.json());

    // 1. Controlled slow route (holds connection in-flight until resolved)
    testApp.post('/audit-slow', concurrencyLimiter, async (_req: Request, res: Response) => {
      await new Promise<void>((resolve) => {
        slowResolvers.push(resolve);
      });
      res.status(200).json({ status: 'completed' });
    });

    // 2. Fast route
    testApp.post('/audit-fast', concurrencyLimiter, (_req: Request, res: Response) => {
      res.status(200).json({ status: 'fast' });
    });

    // 3. Error route (throws exception to test error slot release)
    testApp.post('/audit-error', concurrencyLimiter, (_req: Request, _res: Response, next) => {
      next(new Error('Simulated route failure'));
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
    process.env.MAX_CONCURRENT_AUDITS = '2';
  });

  afterEach(() => {
    process.env.MAX_CONCURRENT_AUDITS = originalEnvMax;
    slowResolvers.forEach((resolve) => resolve());
    slowResolvers = [];
  });

  it('should allow requests when under the MAX_CONCURRENT_AUDITS limit', async () => {
    expect(getActiveAuditsCount()).toBe(0);

    const res = await request(testApp).post('/audit-fast').send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'fast' });
    expect(getActiveAuditsCount()).toBe(0);
  });

  it('should immediately reject with 503 when MAX_CONCURRENT_AUDITS limit is reached', async () => {
    expect(getActiveAuditsCount()).toBe(0);

    // 1. Send 2 native fetch requests that hit the server immediately (filling max 2 slots)
    const req1Promise = fetch(`${serverUrl}/audit-slow`, { method: 'POST' });
    const req2Promise = fetch(`${serverUrl}/audit-slow`, { method: 'POST' });

    // Small delay to allow both HTTP requests to reach Express middleware
    await new Promise((r) => setTimeout(r, 50));

    // Verify 2 slots are occupied
    expect(getActiveAuditsCount()).toBe(2);

    // 2. Send 3rd request - should be immediately rejected with 503
    const res3 = await fetch(`${serverUrl}/audit-fast`, { method: 'POST' });

    expect(res3.status).toBe(503);
    const body3 = await res3.json();
    expect(body3).toEqual({
      error: {
        code: 'CONCURRENCY_LIMIT_EXCEEDED',
        message: 'Concurrency limit of 2 in-flight audits reached. Please retry later.',
      },
    });

    // Active slots should remain 2 (3rd request was rejected without incrementing)
    expect(getActiveAuditsCount()).toBe(2);

    // 3. Resolve held in-flight requests
    slowResolvers.forEach((resolve) => resolve());
    await Promise.all([req1Promise, req2Promise]);

    // 4. Verify all slots are released back to 0
    expect(getActiveAuditsCount()).toBe(0);
  });

  it('should guarantee slot release when downstream route throws an error', async () => {
    expect(getActiveAuditsCount()).toBe(0);

    const res = await request(testApp).post('/audit-error').send();

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(getActiveAuditsCount()).toBe(0);
  });

  it('should guarantee slot release if client closes connection mid-flight', async () => {
    expect(getActiveAuditsCount()).toBe(0);

    // Create custom req/res mock to simulate socket 'close' event
    const reqMock = {} as Request;
    let closeListener: (() => void) | null = null;

    const resMock = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      once: jest.fn((event: string, listener: () => void) => {
        if (event === 'close') {
          closeListener = listener;
        }
      }),
    } as unknown as Response;

    const nextMock = jest.fn();

    // Call middleware
    concurrencyLimiter(reqMock, resMock, nextMock);

    expect(getActiveAuditsCount()).toBe(1);
    expect(nextMock).toHaveBeenCalled();

    // Simulate premature client socket disconnection
    expect(closeListener).not.toBeNull();
    if (closeListener) {
      (closeListener as () => void)();
    }

    // Slot must be decremented back to 0
    expect(getActiveAuditsCount()).toBe(0);
  });
});
