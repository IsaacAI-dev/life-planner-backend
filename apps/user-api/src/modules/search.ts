import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import { searchQuerySchema, sendOk, toDateOnlyString } from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';

export const searchRouter = Router();

/**
 * P-21 — header search. ILIKE is plenty at this scale; full-text would add an
 * index-maintenance burden for no user-visible gain yet.
 *
 * Private activities are included: this route never crosses a user boundary,
 * so the owner should find everything they own.
 */
searchRouter.get(
  '/',
  validate(searchQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { q, limit } = req.query as unknown as { q: string; limit: number };
    const contains = { contains: q, mode: 'insensitive' as const };

    const [activities, goals, notes] = await Promise.all([
      prisma.activity.findMany({
        where: {
          userId: me.id,
          deletedAt: null,
          OR: [{ title: contains }, { description: contains }],
        },
        select: {
          id: true,
          title: true,
          date: true,
          startTime: true,
          isDone: true,
          isPrivate: true,
          category: { select: { id: true, name: true, color: true } },
        },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        take: limit,
      }),
      prisma.goal.findMany({
        where: {
          userId: me.id,
          deletedAt: null,
          OR: [{ title: contains }, { description: contains }],
        },
        select: { id: true, title: true, status: true, featured: true },
        take: limit,
      }),
      prisma.dayNote.findMany({
        where: { userId: me.id, content: contains },
        select: { id: true, date: true, content: true, mood: true },
        orderBy: { date: 'desc' },
        take: limit,
      }),
    ]);

    sendOk(res, {
      query: q,
      activities: activities.map((a) => ({
        ...a,
        date: a.date ? toDateOnlyString(a.date) : null,
      })),
      goals,
      notes: notes.map((n) => ({
        ...n,
        date: toDateOnlyString(n.date),
        content: n.content.length > 160 ? `${n.content.slice(0, 157)}…` : n.content,
      })),
      totals: { activities: activities.length, goals: goals.length, notes: notes.length },
    });
  }),
);
