import { Router, Request, Response, NextFunction } from 'express';
import { AuditRequestSchema } from '../schemas/audit.schema';
import { runAudit } from '../lib/audit';

const router = Router();

router.post('/api/audit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedData = AuditRequestSchema.parse(req.body);

    const auditResult = await runAudit({
      url: validatedData.url,
      timeoutMs: validatedData.timeoutMs,
      forceRefresh: validatedData.forceRefresh,
    });

    res.status(200).json({
      success: true,
      data: auditResult,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
