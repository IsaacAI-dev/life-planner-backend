import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { makeErrorMiddleware, notFoundHandler, ok } from '@life-planner/shared-utils';
import { corsOrigins } from './env.js';
import { logger } from './logger.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { adminAuthRouter } from './modules/adminAuth/adminAuth.routes.js';
import { inboxRouter } from './modules/inbox/inbox.routes.js';
import { conversationsRouter } from './modules/conversations/conversations.routes.js';
import { adminsRouter, usersRouter } from './modules/users/users.routes.js';
import { analyticsRouter } from './modules/analytics/analytics.routes.js';
import { subscriptionsRouter } from './modules/subscriptions/subscriptions.routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  app.get('/health', (_req, res) => ok(res, { status: 'ok', uptime: process.uptime() }));

  const api = express.Router();
  api.use(generalLimiter);

  const apiV1 = express.Router();
  apiV1.use('/auth', adminAuthRouter);

  apiV1.use('/inbox', inboxRouter);
  apiV1.use('/conversations', conversationsRouter);
  apiV1.use('/users', usersRouter);
  apiV1.use('/admins', adminsRouter);
  apiV1.use('/analytics', analyticsRouter);
  apiV1.use('/subscriptions', subscriptionsRouter);

  app.use('/admin/v1', apiV1);

  app.use(notFoundHandler);
  app.use(makeErrorMiddleware(logger));

  return app;
}
