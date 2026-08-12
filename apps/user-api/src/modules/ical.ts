import { Router } from 'express';
import { createEvents, type EventAttributes } from 'ics';
import { prisma } from '@lifeplanner/database';
import { AppError, sendOk, toDateOnlyString } from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth, currentUser } from '../middleware/auth.js';
import { generateOpaqueToken } from '../lib/tokens.js';
import { env } from '../config/env.js';

/** Authenticated half: mint / read the tokenized feed URL. */
export const icalRouter = Router();

icalRouter.get(
  '/feed-url',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    let user = await prisma.user.findUniqueOrThrow({
      where: { id: me.id },
      select: { icalToken: true },
    });
    if (!user.icalToken) {
      user = await prisma.user.update({
        where: { id: me.id },
        data: { icalToken: generateOpaqueToken() },
        select: { icalToken: true },
      });
    }
    sendOk(res, { url: `${env.PUBLIC_BASE_URL}/ical/${user.icalToken}.ics` });
  }),
);

icalRouter.post(
  '/rotate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const user = await prisma.user.update({
      where: { id: me.id },
      data: { icalToken: generateOpaqueToken() },
      select: { icalToken: true },
    });
    sendOk(res, { url: `${env.PUBLIC_BASE_URL}/ical/${user.icalToken}.ics` });
  }),
);

/** Public half: the .ics feed itself, mounted outside /api/v1 and outside auth. */
export const icalPublicRouter = Router();

const toParts = (date: Date, time?: string | null): [number, number, number, number, number] => {
  const [h, m] = (time ?? '09:00').split(':').map(Number);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, m];
};

icalPublicRouter.get(
  '/:token.ics',
  asyncHandler(async (req, res) => {
    const token = req.params.token;
    const user = await prisma.user.findFirst({
      where: { icalToken: token, deletedAt: null },
      select: { id: true, name: true, status: true },
    });
    if (!user || user.status === 'BANNED') throw AppError.notFound('Feed not found');

    const activities = await prisma.activity.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        date: { not: null },
        // Private activities never leave the owner's board through a public feed.
        isPrivate: false,
      },
      select: {
        id: true,
        title: true,
        description: true,
        date: true,
        startTime: true,
        endTime: true,
        isDone: true,
      },
      orderBy: { date: 'asc' },
      take: 2000,
    });

    const events: EventAttributes[] = activities.map((a) => {
      const date = a.date as Date;
      const common = {
        uid: `${a.id}@lifeplanner`,
        title: a.title,
        description: a.description ?? undefined,
        status: (a.isDone ? 'CONFIRMED' : 'TENTATIVE') as 'CONFIRMED' | 'TENTATIVE',
        productId: 'lifeplanner/ics',
      };

      // All-day event when no start time is set.
      if (!a.startTime) {
        return {
          ...common,
          start: [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()],
          startInputType: 'utc',
          duration: { days: 1 },
        } as EventAttributes;
      }

      const start = toParts(date, a.startTime);
      if (a.endTime) {
        return {
          ...common,
          start,
          startInputType: 'utc',
          end: toParts(date, a.endTime),
          endInputType: 'utc',
        } as EventAttributes;
      }

      return {
        ...common,
        start,
        startInputType: 'utc',
        duration: { hours: 1 },
      } as EventAttributes;
    });

    const { error, value } = createEvents(events);
    if (error) throw AppError.internal('Could not build the calendar feed');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="lifeplanner-${toDateOnlyString(new Date())}.ics"`);
    res.send(value ?? '');
  }),
);
