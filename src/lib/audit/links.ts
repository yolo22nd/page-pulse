import * as cheerio from 'cheerio';
import { URL } from 'url';
import { BrokenLinksAudit, BrokenLink } from '../../schemas/audit.schema';

const MAX_CHECKED_LINKS = 20;
const LINK_CHECK_TIMEOUT_MS = 5000;
const CONCURRENCY_LIMIT = 5;

export async function checkBrokenLinks(
  html: string,
  baseUrl: string,
  parentSignal?: AbortSignal,
): Promise<BrokenLinksAudit> {
  const $ = cheerio.load(html);
  const rawHrefs: string[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim();
    if (href) {
      rawHrefs.push(href);
    }
  });

  const validUrls: string[] = [];
  const seen = new Set<string>();

  for (const href of rawHrefs) {
    if (
      href.startsWith('#') ||
      href.startsWith('javascript:') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:')
    ) {
      continue;
    }

    try {
      const resolved = new URL(href, baseUrl).toString();
      if ((resolved.startsWith('http://') || resolved.startsWith('https://')) && !seen.has(resolved)) {
        seen.add(resolved);
        validUrls.push(resolved);
      }
    } catch {
      // Ignore invalid URLs
    }
  }

  const linksToCheck = validUrls.slice(0, MAX_CHECKED_LINKS);
  const skippedCount = Math.max(0, validUrls.length - MAX_CHECKED_LINKS);

  const brokenLinks: BrokenLink[] = [];

  // Bounded concurrency processing
  for (let i = 0; i < linksToCheck.length; i += CONCURRENCY_LIMIT) {
    if (parentSignal?.aborted) break;

    const chunk = linksToCheck.slice(i, i + CONCURRENCY_LIMIT);
    const results = await Promise.all(
      chunk.map((link) => checkSingleLink(link, parentSignal)),
    );

    for (const result of results) {
      if (result) {
        brokenLinks.push(result);
      }
    }
  }

  return {
    checkedCount: linksToCheck.length,
    brokenCount: brokenLinks.length,
    skippedCount,
    brokenLinks,
  };
}

async function checkSingleLink(
  linkUrl: string,
  parentSignal?: AbortSignal,
): Promise<BrokenLink | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LINK_CHECK_TIMEOUT_MS);

  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  try {
    // Try HEAD request first
    let res = await fetch(linkUrl, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    }).catch(() => null);

    // Fallback to GET if HEAD failed or returned 405 Method Not Allowed / 404
    if (!res || res.status === 405 || res.status === 404) {
      const getController = new AbortController();
      const getTimeoutId = setTimeout(() => getController.abort(), LINK_CHECK_TIMEOUT_MS);

      res = await fetch(linkUrl, {
        method: 'GET',
        signal: getController.signal,
        redirect: 'follow',
        headers: { Range: 'bytes=0-1024' },
      }).catch(() => null);

      clearTimeout(getTimeoutId);
    }

    clearTimeout(timeoutId);

    if (!res) {
      return {
        url: linkUrl,
        statusCode: null,
        error: 'Network error or timeout',
      };
    }

    if (res.status >= 400) {
      return {
        url: linkUrl,
        statusCode: res.status,
        error: `HTTP status ${res.status}`,
      };
    }

    return null; // Link is healthy
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const errorMessage = err instanceof Error ? err.message : 'Unknown link check failure';
    return {
      url: linkUrl,
      statusCode: null,
      error: errorMessage,
    };
  } finally {
    if (parentSignal) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}
