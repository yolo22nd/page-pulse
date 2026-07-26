import { Router, Request, Response, NextFunction } from 'express';
import { AuditRequestSchema } from '../schemas/audit.schema';
import { runAudit } from '../lib/audit';
import { concurrencyLimiter } from '../middleware/concurrencyLimiter';
import { getCachedAudit, setCachedAudit } from '../lib/cache';

const router = Router();

router.post(
  '/api/audit',
  concurrencyLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validatedData = AuditRequestSchema.parse(req.body);

      // 1. Cache Read (skipped if forceRefresh is true)
      if (!validatedData.forceRefresh) {
        const cachedResult = await getCachedAudit(validatedData.url);
        if (cachedResult) {
          res.status(200).json({
            success: true,
            data: cachedResult,
          });
          return;
        }
      }

      // 2. Fresh Audit Execution
      const auditResult = await runAudit({
        url: validatedData.url,
        timeoutMs: validatedData.timeoutMs,
        forceRefresh: validatedData.forceRefresh,
      });

      // 3. Cache Write (never cache error responses, only successful 200 audits)
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
