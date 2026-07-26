import Redis from 'ioredis';
import { logger } from './logger';

let redisInstance: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisInstance) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    redisInstance = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      commandTimeout: 1000,
      enableOfflineQueue: false, // Fail fast if Redis is down so API fails open without latency penalty
      retryStrategy: (times) => {
        // Retry connection up to 3 times with exponential backoff, capped at 2 seconds
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    });

    redisInstance.on('error', (err) => {
      logger.warn({ err }, 'Redis client connection error (failing open)');
    });

    redisInstance.on('connect', () => {
      logger.info('Connected to Redis');
    });
  }

  return redisInstance;
}

/**
 * Replace active Redis instance (used for mock injection during integration tests).
 */
export function setRedisClient(client: Redis | null): void {
  redisInstance = client;
}
