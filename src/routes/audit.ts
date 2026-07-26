import { Router, Request, Response, NextFunction } from 'express';
import { AuditRequestSchema } from '../schemas/audit.schema';
import { runAudit } from '../lib/audit';
import { concurrencyLimiter } from '../middleware/concurrencyLimiter';
import { auditRateLimiter } from '../middleware/rateLimiter';
import { getCachedAudit, setCachedAudit } from '../lib/cache';

const router = Router();

router.post(
  '/api/audit',
  auditRateLimiter,
  concurrencyLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validatedData = AuditRequestSchema.parse(req.body);
      const reqRecord = req as unknown as Record<string, unknown>;
      reqRecord.auditTargetUrl = validatedData.url;

      // 1. Cache Read (skipped if forceRefresh is true)
      if (!validatedData.forceRefresh) {
        const cachedResult = await getCachedAudit(validatedData.url);
        if (cachedResult) {
          reqRecord.cacheHit = true;
          res.status(200).json({
            success: true,
            data: cachedResult,
          });
          return;
        }
      }

      reqRecord.cacheHit = false;

      // 2. Fresh Audit Execution
      const auditResult = await runAudit({
        url: validatedData.url,
        timeoutMs: validatedData.timeoutMs,
        forceRefresh: validatedData.forceRefresh,
      });

      // 3. Cache Write (never cache error responses)
      await setCachedAudit(validatedData.url, auditResult);

      res.status(200).json({
        success: true,
        data: {
          ...auditResult,
          cached: false,
          cacheAge: null,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
