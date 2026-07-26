import { Router } from 'express';
import {
  asyncHandler,
  created,
  createGoalSchema,
  createMilestoneSchema,
  idParam,
  ok,
  updateGoalSchema,
  validate,
} from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as svc from './goals.service.js';

export const goalsRouter = Router();
goalsRouter.use(requireAuth);

goalsRouter.get('/', asyncHandler(async (req, res) => {
  ok(res, { goals: await svc.listGoals(currentUserId(req)) });
}));

goalsRouter.post('/', validate({ body: createGoalSchema }), asyncHandler(async (req, res) => {
  created(res, { goal: await svc.createGoal(currentUserId(req), req.body) });
}));

goalsRouter.get('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  ok(res, { goal: await svc.getGoal(currentUserId(req), req.params.id) });
}));

goalsRouter.patch('/:id', validate({ params: idParam, body: updateGoalSchema }), asyncHandler(async (req, res) => {
  ok(res, { goal: await svc.updateGoal(currentUserId(req), req.params.id, req.body) });
}));

goalsRouter.delete('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  await svc.deleteGoal(currentUserId(req), req.params.id);
  ok(res, { deleted: true });
}));

goalsRouter.post('/:id/milestones', validate({ params: idParam, body: createMilestoneSchema }), asyncHandler(async (req, res) => {
  created(res, { milestone: await svc.addMilestone(currentUserId(req), req.params.id, req.body) });
}));
