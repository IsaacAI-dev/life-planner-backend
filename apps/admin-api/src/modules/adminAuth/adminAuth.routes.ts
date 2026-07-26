import { Router } from 'express';
import {
  adminLoginSchema,
  adminRefreshSchema,
  asyncHandler,
  ok,
  validate,
} from '@life-planner/shared-utils';
import { authLimiter } from '../../middleware/rateLimit.js';
import { currentAdmin, requireAdmin } from '../../middleware/auth.js';
import * as svc from './adminAuth.service.js';

export const adminAuthRouter = Router();

adminAuthRouter.post('/login', authLimiter, validate({ body: adminLoginSchema }), asyncHandler(async (req, res) => {
  ok(res, await svc.login(req.body));
}));

adminAuthRouter.post('/refresh', authLimiter, validate({ body: adminRefreshSchema }), asyncHandler(async (req, res) => {
  ok(res, await svc.refresh(req.body.refreshToken));
}));

adminAuthRouter.get('/me', requireAdmin, asyncHandler(async (req, res) => {
  ok(res, { admin: await svc.getMe(currentAdmin(req).id) });
}));
