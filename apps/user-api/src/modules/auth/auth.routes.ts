import { Router } from 'express';
import {
  asyncHandler,
  created,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  ok,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  validate,
} from '@life-planner/shared-utils';
import { authLimiter } from '../../middleware/rateLimit.js';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as authService from './auth.service.js';

export const authRouter = Router();

authRouter.post(
  '/register',
  authLimiter,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const result = await authService.register(req.body);
    created(res, result);
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body);
    ok(res, result);
  }),
);

authRouter.post(
  '/refresh',
  authLimiter,
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    const tokens = await authService.refresh(req.body.refreshToken);
    ok(res, { tokens });
  }),
);

authRouter.post(
  '/logout',
  validate({ body: logoutSchema }),
  asyncHandler(async (req, res) => {
    await authService.logout(req.body.refreshToken);
    ok(res, { loggedOut: true });
  }),
);

authRouter.post(
  '/forgot-password',
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  asyncHandler(async (req, res) => {
    await authService.requestPasswordReset(req.body.email);
    // Always 200 — never reveal whether the email exists.
    ok(res, { requested: true });
  }),
);

authRouter.post(
  '/reset-password',
  authLimiter,
  validate({ body: resetPasswordSchema }),
  asyncHandler(async (req, res) => {
    await authService.resetPassword(req.body.token, req.body.password);
    ok(res, { reset: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await authService.getMe(currentUserId(req));
    ok(res, { user });
  }),
);
