import { Router } from 'express';
import {
  asyncHandler,
  changePasswordSchema,
  deleteAccountSchema,
  ok,
  validate,
} from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as authService from '../auth/auth.service.js';

export const accountRouter = Router();
accountRouter.use(requireAuth);

accountRouter.post(
  '/change-password',
  validate({ body: changePasswordSchema }),
  asyncHandler(async (req, res) => {
    await authService.changePassword(
      currentUserId(req),
      req.body.currentPassword,
      req.body.newPassword,
    );
    ok(res, { changed: true });
  }),
);

accountRouter.delete(
  '/',
  validate({ body: deleteAccountSchema }),
  asyncHandler(async (req, res) => {
    await authService.deleteAccount(currentUserId(req), req.body.password);
    ok(res, { deleted: true });
  }),
);
