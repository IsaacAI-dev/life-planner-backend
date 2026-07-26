import { Router } from 'express';
import { asyncHandler, ok, subscribeSchema, validate } from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as svc from './subscriptions.service.js';

export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireAuth);

subscriptionsRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    ok(res, await svc.getMySubscription(currentUserId(req)));
  }),
);

subscriptionsRouter.post(
  '/subscribe',
  validate({ body: subscribeSchema }),
  asyncHandler(async (req, res) => {
    ok(res, { subscription: await svc.subscribe(currentUserId(req), req.body) });
  }),
);

subscriptionsRouter.post(
  '/cancel',
  asyncHandler(async (req, res) => {
    ok(res, { subscription: await svc.cancel(currentUserId(req)) });
  }),
);
