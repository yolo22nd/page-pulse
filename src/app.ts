import express, { Express } from 'express';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';
import { logger } from './lib/logger';
import healthRouter from './routes/health';

const app: Express = express();

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

export default app;
