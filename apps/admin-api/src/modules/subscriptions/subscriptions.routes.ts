import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler,
  grantSubscriptionSchema,
  id,
  listSubscriptionsQuerySchema,
  ok,
  validate,
} from '@life-planner/shared-utils';
import { requireAdmin } from '../../middleware/auth.js';
import * as svc from './subscriptions.service.js';

const userParam = z.object({ userId: id });

export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireAdmin);

subscriptionsRouter.get(
  '/',
  validate({ query: listSubscriptionsQuerySchema }),
  asyncHandler(async (req, res) => {
    ok(res, await svc.listSubscriptions(req.query as unknown as Parameters<typeof svc.listSubscriptions>[0]));
  }),
);

subscriptionsRouter.post(
  '/:userId/grant',
  validate({ params: userParam, body: grantSubscriptionSchema }),
  asyncHandler(async (req, res) => {
    ok(res, { subscription: await svc.grant(req.params.userId, req.body) });
  }),
);

subscriptionsRouter.post(
  '/:userId/revoke',
  validate({ params: userParam }),
  asyncHandler(async (req, res) => {
    ok(res, { subscription: await svc.revoke(req.params.userId) });
  }),
);
