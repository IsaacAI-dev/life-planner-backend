import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { pinoHttp } from 'pino-http';
import { sendOk } from '@lifeplanner/shared-utils';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { adminGeneralLimiter } from './middleware/rateLimit.js';
import { requireAdmin } from './middleware/auth.js';

import { adminAuthRouter, adminsRouter } from './modules/auth.js';
import { inboxRouter, adminConversationsRouter } from './modules/inbox.js';
import { adminUsersRouter } from './modules/users.js';
import { adminAnalyticsRouter } from './modules/analytics.js';
import {
  adminFoodCatalogRouter,
  adminMealRequestsRouter,
  adminUserFoodRouter,
} from './modules/food.js';
import { assignmentsRouter, insightsRouter } from './modules/assignments.js';
import { billingRouter } from './modules/billing.js';
import { securityRouter } from './modules/security.js';
import { consoleRouter } from './modules/console.js';
import {
  avatarPresetRouter,
  countryConfigRouter,
  planCatalogRouter,
  siteContentRouter,
  staffRouter,
} from './modules/content.js';

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
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req: { url?: string }) => req.url === '/health' } }));

  app.get('/health', (_req, res) => {
    sendOk(res, { status: 'ok', service: 'admin-api', uptime: process.uptime() });
  });

  const api = express.Router();
  api.use(adminGeneralLimiter);

  api.use('/auth', adminAuthRouter);

  // Everything below requires a valid admin token signed with ADMIN_JWT_SECRET.
  api.use('/admins', requireAdmin, adminsRouter);
  api.use('/inbox', requireAdmin, inboxRouter);
  api.use('/conversations', requireAdmin, adminConversationsRouter);
  api.use('/analytics', requireAdmin, adminAnalyticsRouter);
  api.use('/food-catalog', requireAdmin, adminFoodCatalogRouter);

  // Both mount on /users: moderation routes plus the nutrition context routes.
  api.use('/users', requireAdmin, adminUsersRouter);
  api.use('/users', requireAdmin, adminUserFoodRouter);
  api.use('/users', requireAdmin, insightsRouter);

  // --- Addendum 3 ---
  api.use('/assignments', requireAdmin, assignmentsRouter);
  api.use('/meal-requests', requireAdmin, adminMealRequestsRouter);
  api.use('/billing', requireAdmin, billingRouter);
  api.use('/security', requireAdmin, securityRouter);
  // Console content tables — oversight only, every one paginated.
  api.use('/console', requireAdmin, consoleRouter);
  api.use('/site-content', requireAdmin, siteContentRouter);
  api.use('/staff', requireAdmin, staffRouter);
  api.use('/plan-catalog', requireAdmin, planCatalogRouter);
  api.use('/country-config', requireAdmin, countryConfigRouter);
  api.use('/countries', requireAdmin, countryConfigRouter);
  api.use('/avatar-presets', requireAdmin, avatarPresetRouter);

  app.use('/admin/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
