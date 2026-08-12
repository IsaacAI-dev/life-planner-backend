import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  DEFAULT_SETTINGS,
  patchSettingsSchema,
  replaceSettingsSchema,
  sendOk,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';

export const settingsRouter = Router();

const ensureSettings = async (userId: string, timezone: string) =>
  prisma.userSettings.upsert({
    where: { userId },
    update: {},
    create: { userId, timezone },
  });

settingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const settings = await ensureSettings(me.id, me.timezone);
    sendOk(res, { settings });
  }),
);

settingsRouter.put(
  '/',
  validate(replaceSettingsSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    if (req.body.defaultCategoryId) {
      const owned = await prisma.category.findFirst({
        where: { id: req.body.defaultCategoryId, userId: me.id, deletedAt: null },
        select: { id: true },
      });
      if (!owned) throw AppError.badRequest('defaultCategoryId does not belong to you');
    }
    const settings = await prisma.userSettings.upsert({
      where: { userId: me.id },
      update: req.body,
      create: { ...req.body, userId: me.id },
    });
    sendOk(res, { settings });
  }),
);

settingsRouter.patch(
  '/',
  validate(patchSettingsSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const current = await ensureSettings(me.id, me.timezone);

    const { notifications, ...rest } = req.body;
    const mergedNotifications = notifications
      ? { ...(current.notifications as Record<string, unknown>), ...notifications }
      : undefined;

    const settings = await prisma.userSettings.update({
      where: { userId: me.id },
      data: { ...rest, ...(mergedNotifications ? { notifications: mergedNotifications } : {}) },
    });
    sendOk(res, { settings });
  }),
);

/**
 * P-20 — the Settings header has a "Reset to defaults" control. Doing it
 * client-side would duplicate the defaults in the frontend; DEFAULT_SETTINGS in
 * shared-utils stays the single source of truth.
 */
settingsRouter.post(
  '/reset',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const settings = await prisma.userSettings.upsert({
      where: { userId: me.id },
      update: {
        ...DEFAULT_SETTINGS,
        notifications: { ...DEFAULT_SETTINGS.notifications },
        // The person's timezone is a fact about them, not a preference to reset.
        timezone: me.timezone,
      },
      create: {
        userId: me.id,
        ...DEFAULT_SETTINGS,
        notifications: { ...DEFAULT_SETTINGS.notifications },
        timezone: me.timezone,
      },
    });
    sendOk(res, { settings });
  }),
);
