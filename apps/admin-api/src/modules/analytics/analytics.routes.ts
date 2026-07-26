import { Router } from 'express';
import { analyticsQuerySchema, asyncHandler, ok, validate } from '@life-planner/shared-utils';
import { requireAdmin } from '../../middleware/auth.js';
import * as svc from './analytics.service.js';

export const analyticsRouter = Router();
analyticsRouter.use(requireAdmin);

analyticsRouter.get(
  '/overview',
  validate({ query: analyticsQuerySchema }),
  asyncHandler(async (req, res) => {
    ok(res, await svc.overview(req.query as unknown as Parameters<typeof svc.overview>[0]));
  }),
);
