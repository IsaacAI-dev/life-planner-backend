import { Router } from 'express';
import { asyncHandler, ok, statsRangeQuerySchema, validate } from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as svc from './stats.service.js';

export const statsRouter = Router();
statsRouter.use(requireAuth);

statsRouter.get('/overview', validate({ query: statsRangeQuerySchema }), asyncHandler(async (req, res) => {
  ok(res, await svc.overview(currentUserId(req), req.query as never));
}));

statsRouter.get('/categories', validate({ query: statsRangeQuerySchema }), asyncHandler(async (req, res) => {
  ok(res, await svc.categories(currentUserId(req), req.query as never));
}));

statsRouter.get('/streaks', asyncHandler(async (req, res) => {
  ok(res, await svc.streaks(currentUserId(req)));
}));

statsRouter.get('/mood', validate({ query: statsRangeQuerySchema }), asyncHandler(async (req, res) => {
  ok(res, await svc.moodTrend(currentUserId(req), req.query as never));
}));
