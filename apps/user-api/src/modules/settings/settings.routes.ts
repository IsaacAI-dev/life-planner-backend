import { Router } from 'express';
import { asyncHandler, ok, patchSettingsSchema, SettingsSchema, validate } from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as svc from './settings.service.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    ok(res, { settings: await svc.getSettings(currentUserId(req)) });
  }),
);

settingsRouter.put(
  '/',
  validate({ body: SettingsSchema }),
  asyncHandler(async (req, res) => {
    ok(res, { settings: await svc.replaceSettings(currentUserId(req), req.body) });
  }),
);

settingsRouter.patch(
  '/',
  validate({ body: patchSettingsSchema }),
  asyncHandler(async (req, res) => {
    ok(res, { settings: await svc.patchSettings(currentUserId(req), req.body) });
  }),
);
