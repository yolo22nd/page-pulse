import * as cheerio from 'cheerio';
import { PerformanceAudit } from '../../schemas/audit.schema';

/**
 * Performance Heuristic Calculator
 *
 * NOTE: This is a lightweight, server-side static analysis heuristic and is
 * NOT a full Google Lighthouse or RUM performance benchmark.
 *
 * Scoring Mechanics (0 - 100):
 * 1. Response Time Score (Weight 40%):
 *    - <= 300ms: 100 pts
 *    - 300ms - 1000ms: 100 down to 70 pts
 *    - 1000ms - 3000ms: 70 down to 30 pts
 *    - > 3000ms: 0 pts
 *
 * 2. HTML Byte Size Score (Weight 30%):
 *    - <= 100 KB: 100 pts
 *    - 100 KB - 500 KB: 70 pts
 *    - > 500 KB: 30 pts
 *
 * 3. Resource Count Score (Weight 30%):
 *    - Total scripts + stylesheets <= 10: 100 pts
 *    - Total scripts + stylesheets 11 - 25: 70 pts
 *    - Total scripts + stylesheets > 25: 40 pts
 */
export function calculatePerformanceHeuristic(
  html: string,
  responseTimeMs: number,
): PerformanceAudit {
  const htmlSizeBytes = Buffer.byteLength(html, 'utf-8');
  const $ = cheerio.load(html);

  const scriptTagCount = $('script').length;
  const cssTagCount = $('link[rel="stylesheet" i]').length;

  // 1. Response Time Score (0-100)
  let responseTimeScore = 100;
  if (responseTimeMs <= 300) {
    responseTimeScore = 100;
  } else if (responseTimeMs <= 1000) {
    responseTimeScore = 100 - ((responseTimeMs - 300) / 700) * 30;
  } else if (responseTimeMs <= 3000) {
    responseTimeScore = 70 - ((responseTimeMs - 1000) / 2000) * 40;
  } else {
    responseTimeScore = 0;
  }

  // 2. HTML Size Score (0-100)
  const sizeKb = htmlSizeBytes / 1024;
  let htmlSizeScore = 100;
  if (sizeKb <= 100) {
    htmlSizeScore = 100;
  } else if (sizeKb <= 500) {
    htmlSizeScore = 70;
  } else {
    htmlSizeScore = 30;
  }

  // 3. Resource Count Score (0-100)
  const totalResources = scriptTagCount + cssTagCount;
  let resourceScore = 100;
  if (totalResources <= 10) {
    resourceScore = 100;
  } else if (totalResources <= 25) {
    resourceScore = 70;
  } else {
    resourceScore = 40;
  }

  const rawScore =
    responseTimeScore * 0.4 + htmlSizeScore * 0.3 + resourceScore * 0.3;
  const score = Math.round(Math.max(0, Math.min(100, rawScore)));

  return {
    htmlSizeBytes,
    scriptTagCount,
    cssTagCount,
    score,
  };
}
