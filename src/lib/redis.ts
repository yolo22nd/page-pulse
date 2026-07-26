import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({ name: 'redis' });

let redisInstance: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisInstance) {
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    redisInstance = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      lazyConnect: false,
    });
    (redisInstance as unknown as Record<string, unknown>)._isRealRedis = true;

    redisInstance.on('error', (err) => {
      logger.warn({ err }, 'Redis client connection error (failing open)');
    });

    redisInstance.on('connect', () => {
      logger.info('Redis client connected successfully');
    });
  }

  return redisInstance;
}

export function setRedisClient(client: Redis): void {
  if (redisInstance && redisInstance !== client) {
    try {
      redisInstance.disconnect();
    } catch {
      // Ignore disconnect error during cleanup
    }
  }
  redisInstance = client;
}

export async function closeRedisConnection(): Promise<void> {
  if (redisInstance) {
    try {
      await redisInstance.quit();
    } catch {
      redisInstance.disconnect();
    }
    redisInstance = null;
  }
}
