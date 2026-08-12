import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { pinoHttp } from 'pino-http';
import { sendOk } from '@lifeplanner/shared-utils';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { requireAuth } from './middleware/auth.js';

import { authRouter } from './modules/auth.js';
import { categoriesRouter } from './modules/categories.js';
import { activitiesRouter } from './modules/activities.js';
import { calendarRouter } from './modules/calendar.js';
import { daysRouter } from './modules/days.js';
import { goalsRouter } from './modules/goals.js';
import { tagsRouter } from './modules/tags.js';
import { recurringRouter } from './modules/recurring.js';
import { statsRouter } from './modules/stats.js';
import { remindersRouter } from './modules/reminders.js';
import { icalRouter, icalPublicRouter } from './modules/ical.js';
import { chatRouter } from './modules/chat.js';
import { settingsRouter } from './modules/settings.js';
import { analyticsRouter } from './modules/analytics.js';
import { boardSharesRouter, sharedBoardRouter } from './modules/boardShares.js';
import { foodCatalogRouter, foodInventoryRouter, mealPlansRouter } from './modules/food.js';
import { budgetRouter } from './modules/budget.js';
import { seatInviteRouter, subscriptionRouter } from './modules/subscription.js';
import { webhookRouter } from './modules/webhooks.js';
import { storeWebhookRouter } from './modules/storeWebhooks.js';
import { notificationsRouter } from './modules/notifications.js';
import { searchRouter } from './modules/search.js';
import { profileRouter } from './modules/profile.js';
import { mealRequestsRouter } from './modules/mealRequests.js';
import { calendarConnectionsRouter } from './modules/calendarConnections.js';
import { publicContentRouter } from './modules/publicContent.js';

export const createApp = () => {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
      credentials: true,
    }),
  );
  app.use(compression());

  // Billing webhooks need the raw body for signature verification, so they are
  // mounted before the JSON parser and outside /api/v1.
  app.use('/webhooks/billing', webhookRouter);
  // Apple ASSN V2 and Google Play RTDN — also raw-body, also before JSON.
  app.use('/webhooks/store', storeWebhookRouter);

  app.use(express.json({ limit: '15mb' })); // base64 voice notes and avatars
  app.use(express.urlencoded({ extended: true }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req: { url?: string }) => req.url === '/health' } }));

  // Liveness — outside /api/v1 on purpose.
  app.get('/health', (_req, res) => {
    sendOk(res, { status: 'ok', service: 'user-api', uptime: process.uptime() });
  });

  // Public tokenized calendar feed — outside auth.
  app.use('/ical', icalPublicRouter);

  // Landing-page content, plan cards and avatar presets — public by design.
  app.use('/api/v1/public', publicContentRouter);

  // Previewing a seat invitation happens before the invitee has an account.
  app.use('/api/v1/public/seat-invite', seatInviteRouter);

  // Local storage driver serves uploads from disk in development.
  if (env.STORAGE_DRIVER === 'local') {
    app.use('/media', express.static(env.LOCAL_STORAGE_DIR, { maxAge: '1h' }));
  }

  const api = express.Router();
  api.use(generalLimiter);

  // --- public / optional-auth ---
  api.use('/auth', authRouter);
  api.use('/analytics', analyticsRouter); // optionalAuth lives inside the router

  // --- authenticated ---
  api.use('/categories', requireAuth, categoriesRouter);
  api.use('/activities', requireAuth, activitiesRouter);
  api.use('/calendar', requireAuth, calendarRouter);
  api.use('/days', requireAuth, daysRouter);
  api.use('/goals', requireAuth, goalsRouter);
  api.use('/tags', requireAuth, tagsRouter);
  api.use('/recurring', requireAuth, recurringRouter);
  api.use('/stats', requireAuth, statsRouter);
  api.use('/reminders', requireAuth, remindersRouter);
  api.use('/ical', icalRouter); // requireAuth applied per-route
  api.use('/chat', requireAuth, chatRouter);
  api.use('/settings', requireAuth, settingsRouter);

  // --- Addendum 2 ---
  api.use('/board-shares', requireAuth, boardSharesRouter);
  api.use('/users', requireAuth, sharedBoardRouter); // GET /users/:id/board
  api.use('/food-catalog', requireAuth, foodCatalogRouter);
  api.use('/food-inventory', requireAuth, foodInventoryRouter);
  // Must precede /meal-plans: otherwise GET /meal-plans/:date captures 'requests'.
  api.use('/meal-plans/requests', requireAuth, mealRequestsRouter);
  api.use('/meal-plans', requireAuth, mealPlansRouter);
  api.use('/budget', requireAuth, budgetRouter);

  // --- Addendum 3 ---
  api.use('/subscription', requireAuth, subscriptionRouter);
  api.use('/notifications', requireAuth, notificationsRouter);
  api.use('/search', requireAuth, searchRouter);
  api.use('/auth/me/profile', requireAuth, profileRouter);
  api.use('/calendar-connections', requireAuth, calendarConnectionsRouter);

  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
