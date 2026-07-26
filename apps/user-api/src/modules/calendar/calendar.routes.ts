import { Router } from 'express';
import {
  asyncHandler,
  calendarRangeQuerySchema,
  calendarWeekQuerySchema,
  ok,
  validate,
} from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as svc from './calendar.service.js';

export const calendarRouter = Router();
calendarRouter.use(requireAuth);

calendarRouter.get(
  '/',
  validate({ query: calendarRangeQuerySchema }),
  asyncHandler(async (req, res) => {
    ok(res, await svc.getRange(currentUserId(req), req.query as never));
  }),
);

calendarRouter.get(
  '/week',
  validate({ query: calendarWeekQuerySchema }),
  asyncHandler(async (req, res) => {
    const { start } = req.query as { start: string };
    ok(res, await svc.getWeek(currentUserId(req), start));
  }),
);
