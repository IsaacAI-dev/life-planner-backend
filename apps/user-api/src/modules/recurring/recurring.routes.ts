import { Router } from 'express';
import {
  asyncHandler,
  created,
  createRecurringSchema,
  idParam,
  ok,
  updateRecurringSchema,
  validate,
} from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as svc from './recurring.service.js';

export const recurringRouter = Router();
recurringRouter.use(requireAuth);

recurringRouter.get('/', asyncHandler(async (req, res) => {
  ok(res, { templates: await svc.listRecurring(currentUserId(req)) });
}));

recurringRouter.post('/', validate({ body: createRecurringSchema }), asyncHandler(async (req, res) => {
  created(res, { template: await svc.createRecurring(currentUserId(req), req.body) });
}));

recurringRouter.patch('/:id', validate({ params: idParam, body: updateRecurringSchema }), asyncHandler(async (req, res) => {
  ok(res, { template: await svc.updateRecurring(currentUserId(req), req.params.id, req.body) });
}));

recurringRouter.delete('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  await svc.deleteRecurring(currentUserId(req), req.params.id);
  ok(res, { deactivated: true });
}));
