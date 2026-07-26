import express, { Express } from 'express';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';
import { logger } from './lib/logger';
import healthRouter from './routes/health';
import auditRouter from './routes/audit';
import { errorHandler } from './middleware/errorHandler';

const app: Express = express();

// Trust Render / Cloudflare reverse proxy (1 hop) for accurate client IP rate limiting via X-Forwarded-For
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const existingId = (req.headers['x-request-id'] as string) || (req.headers['X-Request-Id'] as string);
      const reqId = existingId || randomUUID();
      res.setHeader('x-request-id', reqId);
      return reqId;
    },
    customAttributeKeys: {
      reqId: 'requestId',
    },
    customProps: (req) => {
      const customData: Record<string, unknown> = {};
      const reqRecord = req as unknown as Record<string, unknown>;
      if (reqRecord.auditTargetUrl) {
        customData.targetUrl = reqRecord.auditTargetUrl;
      }
      if (reqRecord.cacheHit !== undefined) {
        customData.cacheHit = reqRecord.cacheHit;
      }
      if (reqRecord.rejectionReason) {
        customData.rejectionReason = reqRecord.rejectionReason;
      }
      return customData;
    },
  }),
);

app.use('/', healthRouter);
app.use('/', auditRouter);

app.use(errorHandler);

export default app;
