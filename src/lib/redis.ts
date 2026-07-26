import Redis from 'ioredis';
import { logger } from './logger';

let redisInstance: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisInstance) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    redisInstance = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      retryStrategy: (times) => {
        if (times > 5) return null;
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

export function setRedisClient(client: Redis | null): void {
  if (redisInstance && redisInstance !== client) {
    try {
      redisInstance.disconnect();
    } catch {
      // Ignore
    }
  }
  redisInstance = client;
}
