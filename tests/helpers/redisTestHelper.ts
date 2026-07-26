import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { setRedisClient, getRedisClient } from '../../src/lib/redis';

export async function setupTestRedis(): Promise<Redis> {
  const client = getRedisClient();

  if (client.status !== 'ready') {
    await new Promise<void>((resolve) => {
      if (client.status === 'ready') return resolve();
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, 2000);

      function cleanup() {
        client.off('ready', onReady);
        client.off('error', onError);
        clearTimeout(timer);
      }

      client.once('ready', onReady);
      client.once('error', onError);
    });
  }

  try {
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
