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
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
    customAttributeKeys: {
      reqId: 'requestId',
    },
  }),
);

app.use('/', healthRouter);
app.use('/', auditRouter);

app.use(errorHandler);

export default app;
