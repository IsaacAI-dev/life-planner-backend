import { Router } from 'express';
import { asyncHandler, created, createReminderSchema, idParam, ok, validate } from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as svc from './reminders.service.js';

export const remindersRouter = Router();
remindersRouter.use(requireAuth);

remindersRouter.get('/', asyncHandler(async (req, res) => {
  ok(res, { reminders: await svc.listReminders(currentUserId(req)) });
}));

remindersRouter.post('/', validate({ body: createReminderSchema }), asyncHandler(async (req, res) => {
  created(res, { reminder: await svc.createReminder(currentUserId(req), req.body) });
}));

remindersRouter.delete('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  ok(res, { reminder: await svc.cancelReminder(currentUserId(req), req.params.id) });
}));
