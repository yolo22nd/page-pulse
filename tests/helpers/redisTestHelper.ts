import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { setRedisClient, getRedisClient } from '../../src/lib/redis';

export async function setupTestRedis(): Promise<Redis> {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  const testClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 0,
    connectTimeout: 400,
    lazyConnect: true,
    enableOfflineQueue: false,
  });

  try {
    await testClient.connect();
    await testClient.ping();
    await testClient.flushall();
    await testClient.quit();

    const realClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    setRedisClient(realClient);
    return realClient;
  } catch {
    try {
      await testClient.quit();
    } catch {
      // Ignore
    }
    const mock = new RedisMock();
    setRedisClient(mock as unknown as Redis);
    return mock as unknown as Redis;
  }
}

export async function teardownTestRedis(): Promise<void> {
  try {
    const client = getRedisClient();
    if (client && typeof client.flushall === 'function') {
      await client.flushall().catch(() => {});
    }
  } catch {
    // Ignore
  }
}
