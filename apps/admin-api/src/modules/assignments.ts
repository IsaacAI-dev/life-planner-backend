import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  CONVERSATION_LABELS,
  createCoachInsightSchema,
  idParamSchema,
  isOversight,
  parseDateOnly,
  reassignCoachSchema,
  sendOk,
  toDateOnlyString,
} from '@lifeplanner/shared-utils';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentAdmin, requireOversight } from '../middleware/auth.js';
import { publishRealtime, userRoom } from '../lib/realtime.js';

export const assignmentsRouter = Router();
export const insightsRouter = Router();

const userIdParamsSchema = z.object({ id: z.string().min(1) });

/** My clients — or, for oversight, anyone's. */
assignmentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const adminId = (req.query.adminId as string) ?? me.id;

    if (adminId !== me.id && !isOversight(me.roles)) {
      throw AppError.forbidden('Only a Manager or Super Admin can view another admin’s clients');
    }

    const assignments = await prisma.coachAssignment.findMany({
      where: { adminId, status: 'ACTIVE' },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            country: true,
            status: true,
            subscription: { select: { tier: true, status: true, currentPeriodEnd: true } },
          },
        },
      },
      orderBy: { startedAt: 'desc' },
    });

    sendOk(res, { adminId, count: assignments.length, assignments });
  }),
);

assignmentsRouter.get(
  '/user/:id',
  validate(userIdParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const assignments = await prisma.coachAssignment.findMany({
      where: { userId: req.params.id },
      include: { admin: { select: { id: true, name: true, roles: true } } },
      orderBy: { startedAt: 'desc' },
    });

    // A coach may only look up a client of their own.
    if (!isOversight(me.roles) && !assignments.some((a) => a.adminId === me.id && a.status === 'ACTIVE')) {
      throw AppError.forbidden('This person is not one of your clients');
    }

    sendOk(res, { assignments });
  }),
);

/**
 * Move a client from one coach to another. Manager/Superadmin only — the same
 * rule as chat reassignment, since the two are the same act from the person's
 * point of view.
 */
assignmentsRouter.post(
  '/reassign',
  requireOversight,
  validate(reassignCoachSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const { userId, role, toAdminId, reason, moveConversation } = req.body;

    const requiredRole = role === 'FITNESS' ? 'FITNESS_ADMIN' : 'LIFE_COACH_ADMIN';
    const target = await prisma.admin.findFirst({
      where: { id: toAdminId, deletedAt: null },
      select: { id: true, name: true, roles: true, maxClients: true },
    });
    if (!target) throw AppError.notFound('That admin does not exist');
    if (!target.roles.includes(requiredRole)) {
      throw AppError.badRequest(`${target.name} does not hold the ${requiredRole} role`);
    }

    const load = await prisma.coachAssignment.count({
      where: { adminId: target.id, role, status: 'ACTIVE' },
    });
    if (load >= target.maxClients) {
      throw AppError.conflict(`${target.name} is at capacity (${load}/${target.maxClients})`);
    }

    const conversationType = role === 'FITNESS' ? 'FITNESS' : 'LIFE_COACH';

    const assignment = await prisma.$transaction(async (tx) => {
      const current = await tx.coachAssignment.findFirst({
        where: { userId, role, status: 'ACTIVE' },
        select: { id: true, adminId: true },
      });

      if (current) {
        await tx.coachAssignment.update({
          where: { id: current.id },
          data: { status: 'ENDED', endedAt: new Date(), reason: reason ?? null },
        });
      }

      const created = await tx.coachAssignment.create({
        data: { userId, adminId: target.id, role, assignedByAdminId: me.id, reason: reason ?? null },
      });

      if (moveConversation) {
        const conversation = await tx.conversation.findUnique({
          where: { userId_type: { userId, type: conversationType } },
          select: { id: true, assignedAdminId: true },
        });
        if (conversation) {
          await tx.chatReassignment.create({
            data: {
              conversationId: conversation.id,
              fromAdminId: conversation.assignedAdminId,
              toAdminId: target.id,
              byAdminId: me.id,
              reason: reason ?? 'Coach reassignment',
            },
          });
          await tx.conversation.update({
            where: { id: conversation.id },
            data: { assignedAdminId: target.id, status: 'CLAIMED' },
          });
          await tx.message.create({
            data: {
              conversationId: conversation.id,
              senderType: 'SYSTEM',
              kind: 'SYSTEM',
              content: `${target.name} is now your ${CONVERSATION_LABELS[conversationType]}.`,
            },
          });
        }
      }

      return created;
    });

    await prisma.notification.create({
      data: {
        userId,
        type: 'COACH_REPLY',
        title: `You have a new ${CONVERSATION_LABELS[conversationType]}`,
        body: `${target.name} is now looking after you.`,
        href: '/chats',
      },
    });
    await publishRealtime(userRoom(userId), 'coach:reassigned', {
      role,
      admin: { id: target.id, name: target.name },
    });

    sendOk(res, { assignment });
  }),
);

// ---------------------------------------------------------------------------
// Coach insights (P-11 counterpart)
// ---------------------------------------------------------------------------

insightsRouter.get(
  '/:id/insights',
  validate(userIdParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const insights = await prisma.coachInsight.findMany({
      where: { userId: req.params.id },
      include: { admin: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    sendOk(res, {
      insights: insights.map((i) => ({
        ...i,
        periodStart: toDateOnlyString(i.periodStart),
        periodEnd: toDateOnlyString(i.periodEnd),
      })),
    });
  }),
);

insightsRouter.post(
  '/:id/insights',
  validate(userIdParamsSchema, 'params'),
  validate(createCoachInsightSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const user = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw AppError.notFound('User not found');

    const insight = await prisma.coachInsight.create({
      data: {
        userId: user.id,
        adminId: me.id,
        headline: req.body.headline,
        body: req.body.body,
        periodStart: parseDateOnly(req.body.periodStart),
        periodEnd: parseDateOnly(req.body.periodEnd),
      },
      include: { admin: { select: { id: true, name: true, avatarUrl: true } } },
    });

    await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'COACH_REPLY',
        title: 'A new insight from your coach',
        body: insight.headline,
        href: '/insights',
      },
    });

    sendOk(
      res,
      {
        insight: {
          ...insight,
          periodStart: toDateOnlyString(insight.periodStart),
          periodEnd: toDateOnlyString(insight.periodEnd),
        },
      },
      201,
    );
  }),
);

insightsRouter.delete(
  '/:id/insights/:insightId',
  validate(z.object({ id: z.string().min(1), insightId: z.string().min(1) }), 'params'),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const insight = await prisma.coachInsight.findFirst({
      where: { id: req.params.insightId, userId: req.params.id },
      select: { id: true, adminId: true },
    });
    if (!insight) throw AppError.notFound('Insight not found');
    if (insight.adminId !== me.id && !isOversight(me.roles)) {
      throw AppError.forbidden('You can only remove your own insights');
    }
    await prisma.coachInsight.delete({ where: { id: insight.id } });
    sendOk(res, { deleted: true });
  }),
);

/** Feedback-form results, so managers can see how coaches are rated. */
insightsRouter.get(
  '/feedback/summary',
  requireOversight,
  asyncHandler(async (_req, res) => {
    const forms = await prisma.feedbackForm.findMany({
      where: { status: 'COMPLETED' },
      select: {
        platformRating: true,
        lifeCoachRating: true,
        fitnessRating: true,
        supportRating: true,
        ratedLifeCoachId: true,
        ratedFitnessId: true,
        respondedAt: true,
      },
      orderBy: { respondedAt: 'desc' },
      take: 500,
    });

    const mean = (values: (number | null)[]) => {
      const nums = values.filter((v): v is number => v !== null);
      return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null;
    };

    const perCoach = new Map<string, number[]>();
    for (const f of forms) {
      if (f.ratedLifeCoachId && f.lifeCoachRating !== null) {
        perCoach.set(f.ratedLifeCoachId, [...(perCoach.get(f.ratedLifeCoachId) ?? []), f.lifeCoachRating]);
      }
      if (f.ratedFitnessId && f.fitnessRating !== null) {
        perCoach.set(f.ratedFitnessId, [...(perCoach.get(f.ratedFitnessId) ?? []), f.fitnessRating]);
      }
    }

    const coachIds = [...perCoach.keys()];
    const coaches = coachIds.length
      ? await prisma.admin.findMany({
          where: { id: { in: coachIds } },
          select: { id: true, name: true },
        })
      : [];

    sendOk(res, {
      responses: forms.length,
      averages: {
        platform: mean(forms.map((f) => f.platformRating)),
        lifeCoach: mean(forms.map((f) => f.lifeCoachRating)),
        fitness: mean(forms.map((f) => f.fitnessRating)),
        support: mean(forms.map((f) => f.supportRating)),
      },
      byCoach: coaches.map((c) => ({
        adminId: c.id,
        name: c.name,
        responses: perCoach.get(c.id)?.length ?? 0,
        average: mean(perCoach.get(c.id) ?? []),
      })),
    });
  }),
);
