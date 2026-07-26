import { AuditResultData } from '../schemas/audit.schema';
import { normalizeUrl } from './urlNormalizer';
import { getRedisClient } from './redis';
import { logger } from './logger';

export const DEFAULT_CACHE_TTL_SECONDS = 300;

export function getCacheTtl(): number {
  const envTtl = process.env.AUDIT_CACHE_TTL_SECONDS;
  if (envTtl) {
    const parsed = parseInt(envTtl, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_CACHE_TTL_SECONDS;
}

export function getCacheKey(url: string): string {
  const normalized = normalizeUrl(url);
  return `audit:cache:${normalized}`;
}

export async function getCachedAudit(
  rawUrl: string,
): Promise<AuditResultData | null> {
  try {
    const redis = getRedisClient();
    const key = getCacheKey(rawUrl);
    const cachedString = await redis.get(key);

    if (!cachedString) {
      return null;
    }

    const ttlSeconds = await redis.ttl(key);
    const configuredTtl = getCacheTtl();

    const parsedData = JSON.parse(cachedString) as AuditResultData;
    const cacheAge =
      ttlSeconds > 0
        ? Math.max(0, configuredTtl - ttlSeconds)
        : Math.max(0, Math.floor((Date.now() - Date.parse(parsedData.auditedAt)) / 1000));

    return {
      ...parsedData,
      cached: true,
      cacheAge,
    };
  } catch (err: unknown) {
    logger.warn({ err }, 'Redis cache read error (failing open)');
    return null; // Fail open
  }
}

export async function setCachedAudit(
  rawUrl: string,
  data: AuditResultData,
): Promise<void> {
  try {
    const redis = getRedisClient();
    const key = getCacheKey(rawUrl);
    const ttl = getCacheTtl();

    // Ensure cached flag is false when saving to storage
    const storageData: AuditResultData = {
      ...data,
      cached: false,
      cacheAge: null,
    };

    await redis.set(key, JSON.stringify(storageData), 'EX', ttl);
  } catch (err: unknown) {
    logger.warn({ err }, 'Redis cache write error (failing open)');
  }
}
