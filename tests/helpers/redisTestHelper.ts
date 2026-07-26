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
      // Ignore
    }
  }

  try {
    if (client.status === 'close' || client.status === 'end') {
      await client.connect().catch(() => {});
    }

    if ((client.status as string) !== 'ready') {
      await new Promise<void>((resolve) => {
        if ((client.status as string) === 'ready') return resolve();
        const timer = setTimeout(() => resolve(), 3000);
        const onReady = () => {
          clearTimeout(timer);
          resolve();
        };
        const onError = () => {
          clearTimeout(timer);
          resolve();
        };
        client.once('ready', onReady);
        client.once('error', onError);
      });
    }

    if ((client.status as string) === 'ready') {
      await client.flushall();
      return client;
    }
  } catch {
    // Ignore
  }

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
