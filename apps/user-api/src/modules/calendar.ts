import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@lifeplanner/database';
import {
  addDays,
  dateRangeQuerySchema,
  dateString,
  parseDateOnly,
  sendOk,
  startOfWeek,
  toDateOnlyString,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import { buildBoard } from '../lib/board.js';

export const calendarRouter = Router();

const weekQuerySchema = z.object({ start: dateString });

calendarRouter.get(
  '/',
  validate(dateRangeQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { from, to } = req.query as unknown as { from: string; to: string };
    // The owner always sees 100% of their own board, private rows included.
    const board = await buildBoard({ userId: me.id, from, to, includePrivate: true, includeDayNotes: true });
    sendOk(res, board);
  }),
);

calendarRouter.get(
  '/week',
  validate(weekQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { start } = req.query as unknown as { start: string };

    const settings = await prisma.userSettings.findUnique({
      where: { userId: me.id },
      select: { weekStartsOn: true },
    });
    const weekStart = startOfWeek(parseDateOnly(start), settings?.weekStartsOn ?? 1);
    const weekEnd = addDays(weekStart, 6);

    const board = await buildBoard({
      userId: me.id,
      from: weekStart,
      to: weekEnd,
      includePrivate: true,
      includeDayNotes: true,
    });

    sendOk(res, {
      ...board,
      weekStart: toDateOnlyString(weekStart),
      weekEnd: toDateOnlyString(weekEnd),
    });
  }),
);
