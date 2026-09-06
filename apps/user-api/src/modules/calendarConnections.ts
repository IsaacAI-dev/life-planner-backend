import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  createCalendarConnectionSchema,
  idParamSchema,
  sendOk,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';

export const calendarConnectionsRouter = Router();

const publicShape = {
  id: true,
  provider: true,
  label: true,
  syncEnabled: true,
  lastSyncedAt: true,
  createdAt: true,
  _count: { select: { events: true } },
};

calendarConnectionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const connections = await prisma.calendarConnection.findMany({
      where: { userId: me.id },
      select: publicShape,
      orderBy: { createdAt: 'asc' },
    });
    sendOk(res, {
      connections: connections.map((c) => ({ ...c, eventCount: c._count.events, _count: undefined })),
    });
  }),
);

/**
 * ICS is created directly; the OAuth providers return an authorize URL and the
 * connection is only written once the callback completes.
 *
 * Imported events are stored as ImportedEvent, never as Activity: they must not
 * be editable, must not count toward quota and must not affect streaks.
 */
calendarConnectionsRouter.post(
  '/',
  validate(createCalendarConnectionSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const body = req.body as
      | { provider: 'GOOGLE' | 'APPLE' | 'OUTLOOK'; label?: string }
      | { provider: 'ICS'; url: string; label: string };

    if (body.provider === 'ICS') {
      const connection = await prisma.calendarConnection.create({
        data: { userId: me.id, provider: 'ICS', label: body.label, icsUrl: body.url },
        select: publicShape,
      });
      sendOk(res, { connection: { ...connection, eventCount: 0, _count: undefined } }, 201);
      return;
    }

    // OAuth is not wired up yet; returning 501 keeps the contract honest rather
    // than handing back a URL that goes nowhere.
    throw new AppError(
      501,
      AppError.badRequest('').code,
      `${body.provider} calendar sync is not available yet — add the calendar by ICS URL in the meantime.`,
    );
  }),
);

calendarConnectionsRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.calendarConnection.findFirst({
      where: { id: req.params.id, userId: me.id },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Calendar connection not found');

    const connection = await prisma.calendarConnection.update({
      where: { id: owned.id },
      data: { syncEnabled: Boolean(req.body.syncEnabled) },
      select: publicShape,
    });
    sendOk(res, { connection: { ...connection, eventCount: connection._count.events, _count: undefined } });
  }),
);

calendarConnectionsRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.calendarConnection.findFirst({
      where: { id: req.params.id, userId: me.id },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Calendar connection not found');

    await prisma.calendarConnection.delete({ where: { id: owned.id } });
    sendOk(res, { ok: true });
  }),
);
