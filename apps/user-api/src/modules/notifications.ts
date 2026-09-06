import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import { AppError, idParamSchema, listNotificationsQuerySchema, sendOk } from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';

export const notificationsRouter = Router();

/** Cursor pagination on id — stable under concurrent inserts, unlike offsets. */
notificationsRouter.get(
  '/',
  validate(listNotificationsQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { cursor, limit, unreadOnly } = req.query as unknown as {
      cursor?: string;
      limit: number;
      unreadOnly: boolean;
    };

    const items = await prisma.notification.findMany({
      where: { userId: me.id, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;

    sendOk(res, { items: page, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null });
  }),
);

notificationsRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    sendOk(res, {
      count: await prisma.notification.count({ where: { userId: me.id, readAt: null } }),
    });
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const result = await prisma.notification.updateMany({
      where: { userId: me.id, readAt: null },
      data: { readAt: new Date() },
    });
    sendOk(res, { ok: true, marked: result.count });
  }),
);

notificationsRouter.post(
  '/:id/read',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const existing = await prisma.notification.findFirst({
      where: { id: req.params.id, userId: me.id },
      select: { id: true },
    });
    if (!existing) throw AppError.notFound('Notification not found');

    const notification = await prisma.notification.update({
      where: { id: existing.id },
      data: { readAt: new Date() },
    });
    sendOk(res, { notification });
  }),
);
