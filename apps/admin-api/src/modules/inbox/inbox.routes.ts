import { Router } from 'express';
import { asyncHandler, inboxQuerySchema, ok, validate } from '@life-planner/shared-utils';
import { currentAdmin, requireAdmin } from '../../middleware/auth.js';
import * as svc from './inbox.service.js';

export const inboxRouter = Router();
inboxRouter.use(requireAdmin);

inboxRouter.get('/', validate({ query: inboxQuerySchema }), asyncHandler(async (req, res) => {
  ok(res, { conversations: await svc.listInbox(currentAdmin(req).id, req.query as never) });
}));

inboxRouter.get('/counts', asyncHandler(async (req, res) => {
  ok(res, await svc.inboxCounts(currentAdmin(req).id));
}));
