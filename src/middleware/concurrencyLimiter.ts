import { Request, Response, NextFunction } from 'express';

/**
 * In-memory active audit counter for single-instance Node web service.
 *
 * NOTE: For multi-instance horizontal scaling, rate limiting and distributed caching
 * will use Redis. However, for per-node concurrency protection (preventing CPU/memory
 * exhaustion on a single Render instance), an in-memory counter is used.
 */
let activeAuditsCount = 0;

/**
 * Returns current count of active in-flight audit operations.
 * Primarily used for metrics logging and unit testing.
 */
export function getActiveAuditsCount(): number {
  return activeAuditsCount;
}

/**
 * Resets active audit counter to zero.
 * Intended exclusively for test setup and teardown.
 */
export function resetActiveAuditsCount(): void {
  activeAuditsCount = 0;
}

/**
 * Hand-rolled Counter-based Concurrency Limiting Middleware
 *
 * CORRECTNESS GUARANTEE:
 * 1. Reads max concurrency threshold from process.env.MAX_CONCURRENT_AUDITS (default: 10).
 * 2. If activeAuditsCount >= max, immediately returns HTTP 503 CONCURRENCY_LIMIT_EXCEEDED
 *    without queuing the request.
 * 3. On accepting a request, increments activeAuditsCount by 1.
 * 4. Hooks into both response 'finish' (normal completion / error response sent) and 'close'
 *    (client disconnected mid-flight) events.
 * 5. Uses a scoped boolean `decremented` flag to guarantee activeAuditsCount is decremented
 *    EXACTLY ONCE for every accepted request under all possible execution outcomes (success,
 *    Zod validation error, upstream fetch failure, hard operation timeout, or client abort).
 */
export function concurrencyLimiter(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_AUDITS || '10', 10);

  if (activeAuditsCount >= maxConcurrent) {
    res.status(503).json({
      error: {
        code: 'CONCURRENCY_LIMIT_EXCEEDED',
        message: `Concurrency limit of ${maxConcurrent} in-flight audits reached. Please retry later.`,
      },
    });
    return;
  }

  activeAuditsCount++;
  let decremented = false;

  const releaseSlot = () => {
    if (!decremented) {
      decremented = true;
      activeAuditsCount = Math.max(0, activeAuditsCount - 1);
    }
  };

  // Guarantee slot cleanup on response completion or premature socket termination
  res.once('finish', releaseSlot);
  res.once('close', releaseSlot);

  next();
}
