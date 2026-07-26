import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { makeErrorMiddleware, notFoundHandler, ok } from '@life-planner/shared-utils';
import { corsOrigins } from './env.js';
import { logger } from './logger.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { accountRouter } from './modules/account/account.routes.js';
import { subscriptionsRouter } from './modules/subscriptions/subscriptions.routes.js';
import { categoriesRouter } from './modules/categories/categories.routes.js';
import { activitiesRouter } from './modules/activities/activities.routes.js';
import { dayNotesRouter } from './modules/dayNotes/dayNotes.routes.js';
import { calendarRouter } from './modules/calendar/calendar.routes.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { goalsRouter } from './modules/goals/goals.routes.js';
import { tagsRouter } from './modules/tags/tags.routes.js';
import { recurringRouter } from './modules/recurring/recurring.routes.js';
import { statsRouter } from './modules/stats/stats.routes.js';
import { remindersRouter } from './modules/reminders/reminders.routes.js';
import { icalRouter } from './modules/ical/ical.routes.js';
import { chatRouter } from './modules/chat/chat.routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind a proxy/load balancer; needed for rate-limit + req.protocol
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  // Liveness/readiness (unauthenticated, unthrottled).
  app.get('/health', (req: Request, res: Response) => ok(res, { status: 'ok', uptime: process.uptime() }));

  const api = express.Router();
  api.use(generalLimiter);

  const apiV1 = express.Router();
  apiV1.use('/auth', authRouter);
  apiV1.use('/account', accountRouter);
  apiV1.use('/subscriptions', subscriptionsRouter);

  apiV1.use('/categories', categoriesRouter);
  apiV1.use('/activities', activitiesRouter);
  apiV1.use('/days', dayNotesRouter);
  apiV1.use('/calendar', calendarRouter);
  apiV1.use('/settings', settingsRouter);
  apiV1.use('/goals', goalsRouter);
  apiV1.use('/tags', tagsRouter);
  apiV1.use('/recurring', recurringRouter);
  apiV1.use('/stats', statsRouter);
  apiV1.use('/reminders', remindersRouter);
  apiV1.use('/ical', icalRouter);
  apiV1.use('/chat', chatRouter);
  apiV1.get('/health', (req: Request, res: Response) => ok(res, { status: 'v1 - okay', uptime: process.uptime() }));

  app.use('/api/v1', apiV1);

  app.use(notFoundHandler);
  app.use(makeErrorMiddleware(logger));

  return app;
}
