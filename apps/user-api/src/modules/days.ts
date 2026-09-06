import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  dateParamSchema,
  parseDateOnly,
  sendOk,
  upsertDayNoteSchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import { serializeDayNote } from '../lib/serializers.js';

export const daysRouter = Router();

daysRouter.put(
  '/:date/note',
  validate(dateParamSchema, 'params'),
  validate(upsertDayNoteSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const date = parseDateOnly(req.params.date);
    const note = await prisma.dayNote.upsert({
      where: { userId_date: { userId: me.id, date } },
      update: { content: req.body.content, mood: req.body.mood ?? null },
      create: { userId: me.id, date, content: req.body.content, mood: req.body.mood ?? null },
    });
    sendOk(res, { note: serializeDayNote(note) });
  }),
);

daysRouter.get(
  '/:date/note',
  validate(dateParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const note = await prisma.dayNote.findUnique({
      where: { userId_date: { userId: me.id, date: parseDateOnly(req.params.date) } },
    });
    if (!note) throw AppError.notFound('No note for that day');
    sendOk(res, { note: serializeDayNote(note) });
  }),
);

daysRouter.delete(
  '/:date/note',
  validate(dateParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    await prisma.dayNote.deleteMany({
      where: { userId: me.id, date: parseDateOnly(req.params.date) },
    });
    sendOk(res, { deleted: true });
  }),
);
