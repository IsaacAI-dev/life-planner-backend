import { Router } from 'express';
import {
  asyncHandler,
  bulkCreateActivitySchema,
  created,
  createActivitySchema,
  idParam,
  listActivitiesQuerySchema,
  ok,
  reorderActivitiesSchema,
  toggleActivitySchema,
  updateActivitySchema,
  validate,
} from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as svc from './activities.service.js';

export const activitiesRouter = Router();
activitiesRouter.use(requireAuth);

activitiesRouter.get(
  '/',
  validate({ query: listActivitiesQuerySchema }),
  asyncHandler(async (req, res) => {
    const activities = await svc.listActivities(currentUserId(req), req.query as never);
    ok(res, { activities });
  }),
);

activitiesRouter.post(
  '/',
  validate({ body: createActivitySchema }),
  asyncHandler(async (req, res) => {
    created(res, { activity: await svc.createActivity(currentUserId(req), req.body) });
  }),
);

activitiesRouter.post(
  '/bulk',
  validate({ body: bulkCreateActivitySchema }),
  asyncHandler(async (req, res) => {
    created(res, await svc.bulkCreateActivities(currentUserId(req), req.body));
  }),
);

activitiesRouter.post(
  '/reorder',
  validate({ body: reorderActivitiesSchema }),
  asyncHandler(async (req, res) => {
    const activities = await svc.reorderActivities(currentUserId(req), req.body);
    ok(res, { activities });
  }),
);

activitiesRouter.delete(
  '/batch/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    ok(res, await svc.deleteBatch(currentUserId(req), req.params.id));
  }),
);

activitiesRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    ok(res, { activity: await svc.getActivity(currentUserId(req), req.params.id) });
  }),
);

activitiesRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateActivitySchema }),
  asyncHandler(async (req, res) => {
    const activity = await svc.updateActivity(currentUserId(req), req.params.id, req.body);
    ok(res, { activity });
  }),
);

activitiesRouter.patch(
  '/:id/toggle',
  validate({ params: idParam, body: toggleActivitySchema }),
  asyncHandler(async (req, res) => {
    const activity = await svc.toggleActivity(currentUserId(req), req.params.id, req.body.isDone);
    ok(res, { activity });
  }),
);

activitiesRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await svc.deleteActivity(currentUserId(req), req.params.id);
    ok(res, { deleted: true });
  }),
);
