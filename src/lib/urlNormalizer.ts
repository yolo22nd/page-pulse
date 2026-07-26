import { URL } from 'url';

/**
 * Normalizes a target URL for consistent Redis cache key generation.
 *
 * Normalization Rules:
 * 1. Lowercase scheme and hostname.
 * 2. Remove default ports (:80 for http, :443 for https).
 * 3. Sort query parameter keys alphabetically.
 * 4. Remove trailing slash from pathname (except for root "/").
 */
export function normalizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());

  // 1. Lowercase protocol & hostname
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();

  // 2. Remove default ports
  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }

  // 3. Remove trailing slash from pathname if length > 1
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  // 4. Sort query parameter keys alphabetically
  parsed.searchParams.sort();

  return parsed.toString();
}
