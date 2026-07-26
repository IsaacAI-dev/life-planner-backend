import { Router } from 'express';
import {
  asyncHandler,
  created,
  createAdminSchema,
  idParam,
  listUsersQuerySchema,
  ok,
  suspendUserSchema,
  validate,
} from '@life-planner/shared-utils';
import { requireAdmin, requireSuperadmin } from '../../middleware/auth.js';
import * as svc from './users.service.js';

/** User management (any admin can view/suspend; deletion is SUPERADMIN-only). */
export const usersRouter = Router();
usersRouter.use(requireAdmin);

usersRouter.get('/', validate({ query: listUsersQuerySchema }), asyncHandler(async (req, res) => {
  ok(res, await svc.listUsers(req.query as unknown as Parameters<typeof svc.listUsers>[0]));
}));

usersRouter.get('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  ok(res, { user: await svc.getUser(req.params.id) });
}));

usersRouter.post(
  '/:id/suspend',
  validate({ params: idParam, body: suspendUserSchema }),
  asyncHandler(async (req, res) => {
    ok(res, { user: await svc.suspendUser(req.params.id, req.body) });
  }),
);

usersRouter.post('/:id/unsuspend', validate({ params: idParam }), asyncHandler(async (req, res) => {
  ok(res, { user: await svc.unsuspendUser(req.params.id) });
}));

usersRouter.delete(
  '/:id',
  requireSuperadmin,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    ok(res, await svc.deleteUser(req.params.id));
  }),
);

/** Admin account management (SUPERADMIN only). */
export const adminsRouter = Router();
adminsRouter.use(requireAdmin, requireSuperadmin);

adminsRouter.get('/', asyncHandler(async (_req, res) => {
  ok(res, { admins: await svc.listAdmins() });
}));

adminsRouter.post('/', validate({ body: createAdminSchema }), asyncHandler(async (req, res) => {
  created(res, { admin: await svc.createAdmin(req.body) });
}));
