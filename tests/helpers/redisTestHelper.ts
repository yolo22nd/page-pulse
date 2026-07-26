import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { getRedisClient, setRedisClient } from '../../src/lib/redis';

export async function setupTestRedis(): Promise<Redis> {
  const client = getRedisClient();
  try {
    if (client.status === 'wait' || client.status === 'end') {
      await client.connect();
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
