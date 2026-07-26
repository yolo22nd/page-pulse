import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient } from '../lib/redis';

const scriptMap = new Map<string, string>();

export function createRateLimiter() {
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
  const limit = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '20', 10);

  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true, // Fail open if Redis store is unreachable so rate limiter doesn't crash audit API
    validate: { default: false },
    store: new RedisStore({
      prefix: 'audit:ratelimit:',
      sendCommand: async (command: string, ...args: string[]) => {
        const client = getRedisClient() as unknown as Record<string, (...a: unknown[]) => unknown>;
        const cmdLower = command.toLowerCase();

        // 1. ioredis-mock custom fallback for script loading and evalsha execution
        if (cmdLower === 'script' && args[0]?.toLowerCase() === 'load') {
          const scriptText = args[1];
          const sha = `sha_${scriptMap.size}_${Math.random()}`;
          scriptMap.set(sha, scriptText);
          return sha as import('rate-limit-redis').RedisReply;
        }

        if (cmdLower === 'evalsha') {
          const sha = args[0];
          const scriptText = scriptMap.get(sha);
          if (scriptText && typeof client.eval === 'function') {
            return (await client.eval(scriptText, ...args.slice(1))) as import('rate-limit-redis').RedisReply;
          }
        }

        // 2. Real ioredis client execution
        if (typeof client.call === 'function') {
          return (await client.call(command, ...args)) as import('rate-limit-redis').RedisReply;
        }

        if (cmdLower === 'eval' && typeof client.eval === 'function') {
          return (await client.eval(...args)) as import('rate-limit-redis').RedisReply;
        }

        if (typeof client[cmdLower] === 'function') {
          return (await client[cmdLower](...args)) as import('rate-limit-redis').RedisReply;
        }

        throw new Error(`Redis command '${command}' is not supported by current client instance`);
      },
    }),
    handler: (req, res) => {
      (req as unknown as Record<string, unknown>).rejectionReason = 'RATE_LIMIT_EXCEEDED';
      res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many audit requests from this IP. Please try again later.',
        },
      });
    },
  });
}

let rateLimiterInstance: ReturnType<typeof rateLimit> | null = null;

export function resetAuditRateLimiter(): void {
  rateLimiterInstance = null;
}

export function getAuditRateLimiter() {
  if (!rateLimiterInstance) {
    rateLimiterInstance = createRateLimiter();
  }
  return rateLimiterInstance;
}

/**
 * Dynamic Rate Limiter Middleware
 * Uses cached rate limiter instance, resetting on configuration change if needed.
 */
export function auditRateLimiter(req: Request, res: Response, next: NextFunction) {
  const limiter = getAuditRateLimiter();
  limiter(req, res, next);
}
