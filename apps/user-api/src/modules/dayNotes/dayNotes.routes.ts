import { Router } from 'express';
import {
  asyncHandler,
  dateParamSchema,
  ok,
  upsertDayNoteSchema,
  validate,
} from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as svc from './dayNotes.service.js';

// Mounted at /days; routes are /:date/note
export const dayNotesRouter = Router();
dayNotesRouter.use(requireAuth);

dayNotesRouter.get(
  '/:date/note',
  validate({ params: dateParamSchema }),
  asyncHandler(async (req, res) => {
    ok(res, { note: await svc.getDayNote(currentUserId(req), req.params.date) });
  }),
);

dayNotesRouter.put(
  '/:date/note',
  validate({ params: dateParamSchema, body: upsertDayNoteSchema }),
  asyncHandler(async (req, res) => {
    ok(res, { note: await svc.upsertDayNote(currentUserId(req), req.params.date, req.body) });
  }),
);

dayNotesRouter.delete(
  '/:date/note',
  validate({ params: dateParamSchema }),
  asyncHandler(async (req, res) => {
    await svc.deleteDayNote(currentUserId(req), req.params.date);
    ok(res, { deleted: true });
  }),
);
