import { URL } from 'url';
import { AuditResultData, SeoAudit, BrokenLinksAudit } from '../../schemas/audit.schema';
import { checkSsl } from './ssl';
import { parseSeo } from './seo';
import { checkBrokenLinks } from './links';
import { calculatePerformanceHeuristic } from './performance';
import {
  UpstreamFetchError,
  RedirectLimitExceededError,
  AuditTimeoutError,
} from '../errors';

const MAX_REDIRECTS = 5;

export interface AuditOptions {
  url: string;
  timeoutMs: number;
  forceRefresh?: boolean;
}

export async function runAudit(options: AuditOptions): Promise<AuditResultData> {
  const { url, timeoutMs } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const result = await executeAudit(url, controller.signal, timeoutMs);
    clearTimeout(timeoutId);
    return result;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw new AuditTimeoutError(`Audit operation timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

async function executeAudit(
  initialUrl: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<AuditResultData> {
  const startTime = Date.now();
  const errors: string[] = [];
  const redirectChain: string[] = [];

  let currentUrl = initialUrl;
  let response: Response | null = null;
  let redirectCount = 0;

  // Manual redirect tracking loop (cap at 5 redirects)
  while (redirectCount <= MAX_REDIRECTS) {
    if (signal.aborted) {
      throw new AuditTimeoutError(`Audit operation timed out after ${timeoutMs}ms`);
    }

    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          'User-Agent': 'PagePulse-Auditor/1.0',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
    } catch (err: unknown) {
      if (signal.aborted) {
        throw new AuditTimeoutError(`Audit operation timed out after ${timeoutMs}ms`);
      }
      const msg = err instanceof Error ? err.message : 'Failed to connect to target URL';
      throw new UpstreamFetchError(`Unable to fetch URL '${currentUrl}': ${msg}`);
    }

    const isRedirect = response.status >= 300 && response.status < 400;
    if (isRedirect) {
      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) {
        throw new RedirectLimitExceededError(
          `Exceeded maximum redirect limit of ${MAX_REDIRECTS} redirects`,
        );
      }

      const location = response.headers.get('location');
      if (!location) {
        throw new UpstreamFetchError(
          `Received redirect status ${response.status} with no Location header`,
        );
      }

      const resolvedUrl = new URL(location, currentUrl).toString();
      redirectChain.push(resolvedUrl);
      currentUrl = resolvedUrl;
    } else {
      break;
    }
  }

  if (!response) {
    throw new UpstreamFetchError(`Unable to fetch URL '${initialUrl}'`);
  }

  const responseTimeMs = Date.now() - startTime;
  const finalStatusCode = response.status;

  let html = '';
  try {
    html = await response.text();
  } catch {
    html = '';
  }

  // Sub-check 1: SSL Check (Graceful degradation)
  let sslResult = null;
  try {
    sslResult = await checkSsl(currentUrl, 3000);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'SSL inspection failed';
    errors.push(`SSL Check Error: ${msg}`);
  }

  // Sub-check 2: SEO Parse
  let seoResult: SeoAudit;
  try {
    seoResult = parseSeo(html);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'SEO parsing failed';
    errors.push(`SEO Check Error: ${msg}`);
    seoResult = {
      title: null,
      metaDescription: null,
      canonicalUrl: null,
      h1Count: 0,
      firstH1: null,
      metaRobots: null,
    };
  }

  // Sub-check 3: Broken Links Check (Graceful degradation)
  let brokenLinksResult: BrokenLinksAudit;
  try {
    brokenLinksResult = await checkBrokenLinks(html, currentUrl, signal);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Broken links check failed';
    errors.push(`Broken Links Check Error: ${msg}`);
    brokenLinksResult = {
      checkedCount: 0,
      brokenCount: 0,
      skippedCount: 0,
      brokenLinks: [],
    };
  }

  // Sub-check 4: Performance Heuristic
  const performanceResult = calculatePerformanceHeuristic(html, responseTimeMs);

  // Sub-check 5: Overall Composite Score Calculation (0-100)
  const overallScore = computeCompositeScore({
    statusCode: finalStatusCode,
    responseTimeMs,
    ssl: sslResult,
    seo: seoResult,
    brokenLinks: brokenLinksResult,
    performanceScore: performanceResult.score,
  });

  return {
    url: initialUrl,
    auditedAt: new Date().toISOString(),
    overallScore,
    http: {
      statusCode: finalStatusCode,
      responseTimeMs,
      redirectChain,
    },
    ssl: sslResult,
    seo: seoResult,
    brokenLinks: brokenLinksResult,
    performance: performanceResult,
    errors,
    cached: false,
    cacheAge: null,
  };
}

/**
 * Composite Score Weighting Logic (0 - 100)
 *
 * Weighting Breakdown:
 * 1. HTTP Availability & Speed (30%):
 *    - 200-299 OK status: base 100 points
 *    - 300-399 status: 70 points
 *    - 400+ status: 0 points
 *    - Reduced if response time > 1000ms
 *
 * 2. SSL Security (15%):
 *    - Valid certificate: 100 points
 *    - Invalid or non-HTTPS: 0 points
 *
 * 3. SEO Completeness (25%):
 *    - Title tag present: +25%
 *    - Meta description present: +25%
 *    - H1 tag present: +25%
 *    - Canonical URL present: +25%
 *
 * 4. Broken Link Ratio (15%):
 *    - (checked - broken) / checked * 100 (100 if checked == 0)
 *
 * 5. Performance Score (15%):
 *    - Directly uses performance heuristic score (0-100)
 */
function computeCompositeScore(params: {
  statusCode: number;
  responseTimeMs: number;
  ssl: { isValid: boolean } | null;
  seo: SeoAudit;
  brokenLinks: BrokenLinksAudit;
  performanceScore: number;
}): number {
  // 1. HTTP Score (30%)
  let httpScore = 0;
  if (params.statusCode >= 200 && params.statusCode < 300) {
    httpScore = 100;
  } else if (params.statusCode >= 300 && params.statusCode < 400) {
    httpScore = 70;
  } else {
    httpScore = 0;
  }

  if (params.responseTimeMs > 2000) {
    httpScore = Math.max(0, httpScore - 30);
  } else if (params.responseTimeMs > 1000) {
    httpScore = Math.max(0, httpScore - 15);
  }

  // 2. SSL Score (15%)
  const sslScore = params.ssl?.isValid ? 100 : 0;

  // 3. SEO Score (25%)
  let seoPoints = 0;
  if (params.seo.title) seoPoints += 25;
  if (params.seo.metaDescription) seoPoints += 25;
  if (params.seo.h1Count > 0) seoPoints += 25;
  if (params.seo.canonicalUrl) seoPoints += 25;
  const seoScore = seoPoints;

  // 4. Broken Links Score (15%)
  let brokenLinkScore = 100;
  if (params.brokenLinks.checkedCount > 0) {
    const validCount =
      params.brokenLinks.checkedCount - params.brokenLinks.brokenCount;
    brokenLinkScore = Math.round(
      (validCount / params.brokenLinks.checkedCount) * 100,
    );
  }

  // 5. Performance Score (15%)
  const perfScore = params.performanceScore;

  const rawComposite =
    httpScore * 0.3 +
    sslScore * 0.15 +
    seoScore * 0.25 +
    brokenLinkScore * 0.15 +
    perfScore * 0.15;

  return Math.round(Math.max(0, Math.min(100, rawComposite)));
}
