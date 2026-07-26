import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { setRedisClient, getRedisClient } from '../../src/lib/redis';

export async function setupTestRedis(): Promise<Redis> {
  const client = getRedisClient();

  if (client.status === 'ready') {
    try {
      await client.flushall();
      return client;
    } catch {
      // Fallback below
    }
  }

  try {
    if (client.status === 'close' || client.status === 'end') {
      await client.connect();
    }

    if (client.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        if (client.status === 'ready') return resolve();
        const timer = setTimeout(() => reject(new Error('Redis connect timeout')), 3000);
        client.once('ready', () => {
          clearTimeout(timer);
          resolve();
        });
        client.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    }

    await client.flushall();
    return client;
  } catch {
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
