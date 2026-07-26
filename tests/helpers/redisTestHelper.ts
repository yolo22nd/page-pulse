import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { setRedisClient, getRedisClient } from '../../src/lib/redis';

export async function setupTestRedis(): Promise<Redis> {
  const client = getRedisClient();

  if (client.status === 'close' || client.status === 'end') {
    try {
      await client.connect();
    } catch {
      // Ignore
    }
  }

  if (client.status === 'ready') {
    try {
      await client.flushall();
      return client;
    } catch {
      // Ignore
    }
  }

  // Wait for client to connect if it's currently connecting
  if (client.status === 'connecting' || client.status === 'reconnecting') {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 2000);
      client.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
      client.once('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    if ((client.status as string) === 'ready') {
      try {
        await client.flushall();
        return client;
      } catch {
        // Ignore
      }
    }
  }

  // Fallback to ioredis-mock if real Redis is unavailable or fails to connect
  const mock = new RedisMock();
  setRedisClient(mock as unknown as Redis);
  return mock as unknown as Redis;
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
