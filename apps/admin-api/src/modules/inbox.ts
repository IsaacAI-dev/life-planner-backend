import { Router } from 'express';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  AppError,
  CONVERSATION_LABELS,
  MESSAGE_EDIT_WINDOW_MINUTES,
  MESSAGE_PURGE_DAYS,
  adminInboxQuerySchema,
  editMessageSchema,
  idParamSchema,
  isOversight,
  messageHistoryQuerySchema,
  paginate,
  parseDateOnly,
  reactToMessageSchema,
  reassignConversationSchema,
  sendFeedbackFormSchema,
  sendMessageV3Schema,
  sendOk,
  sendRecommendationSchema,
  servableConversationTypes,
} from '@lifeplanner/shared-utils';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentAdmin, requireOversight } from '../middleware/auth.js';
import { conversationRoom, publishRealtime, userRoom } from '../lib/realtime.js';

export const inboxRouter = Router();
export const adminConversationsRouter = Router();

const PAGE_SIZE = 25;
const messageParamsSchema = z.object({ id: z.string().min(1), messageId: z.string().min(1) });

const messageSelect = {
  id: true,
  conversationId: true,
  kind: true,
  senderType: true,
  senderUserId: true,
  senderAdminId: true,
  content: true,
  replyToId: true,
  editedAt: true,
  editCount: true,
  readAt: true,
  createdAt: true,
  attachments: true,
  reactions: { select: { emoji: true, userId: true, adminId: true } },
  recommendation: {
    select: { id: true, kind: true, status: true, payload: true, createdEntityId: true },
  },
  senderAdmin: { select: { id: true, name: true, avatarUrl: true } },
  replyTo: {
    select: {
      id: true,
      content: true,
      senderType: true,
      deletedAt: true,
      senderUser: { select: { name: true } },
      senderAdmin: { select: { name: true } },
    },
  },
} satisfies Prisma.MessageSelect;

/**
 * A coach may only reach conversations of the types they staff, and only their
 * own or unassigned ones. Manager and Superadmin see everything — they are the
 * only roles permitted to read other admins' chats.
 */
async function reachableConversation(
  admin: { id: string; roles: string[] },
  conversationId: string,
) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          status: true,
          country: true,
          avatarUrl: true,
          /// Powers the personality popover on the chat screen. Admin-only —
          /// this field is never selected by any user-facing endpoint.
          personalityNotes: true,
          subscription: { select: { tier: true, status: true } },
        },
      },
      assignedAdmin: { select: { id: true, name: true } },
    },
  });
  if (!conversation) throw AppError.notFound('Conversation not found');

  if (isOversight(admin.roles)) return conversation;

  if (!servableConversationTypes(admin.roles).includes(conversation.type)) {
    throw AppError.forbidden('You do not staff this kind of conversation');
  }
  if (conversation.assignedAdminId && conversation.assignedAdminId !== admin.id) {
    throw AppError.forbidden('This conversation is assigned to another admin');
  }
  return conversation;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

inboxRouter.get(
  '/',
  validate(adminInboxQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const { status, type, assigned, adminId, page } = req.query as unknown as {
      status?: string;
      type?: string;
      assigned: 'me' | 'unassigned' | 'any';
      adminId?: string;
      page: number;
    };

    const oversight = isOversight(me.roles);
    if ((assigned === 'any' || adminId) && !oversight) {
      throw AppError.forbidden('Only a Manager or Super Admin can view other admins’ queues');
    }

    const where: Prisma.ConversationWhereInput = {
      ...(status ? { status: status as never } : {}),
      ...(type ? { type: type as never } : {}),
      // A coach's inbox is always bounded to the types they staff.
      ...(oversight ? {} : { type: { in: servableConversationTypes(me.roles) as never[] } }),
      ...(adminId
        ? { assignedAdminId: adminId }
        : assigned === 'me'
          ? { assignedAdminId: me.id }
          : assigned === 'unassigned'
            ? { assignedAdminId: null }
            : {}),
    };

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true, status: true } },
          assignedAdmin: { select: { id: true, name: true } },
          messages: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, content: true, kind: true, senderType: true, createdAt: true },
          },
          _count: {
            select: {
              messages: { where: { deletedAt: null, senderType: 'USER', readAt: null } },
            },
          },
        },
        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.conversation.count({ where }),
    ]);

    sendOk(
      res,
      paginate(
        conversations.map((c) => ({
          ...c,
          label: CONVERSATION_LABELS[c.type],
          unreadCount: c._count.messages,
          lastMessage: c.messages[0] ?? null,
          messages: undefined,
        })),
        page,
        PAGE_SIZE,
        total,
      ),
    );
  }),
);

inboxRouter.get(
  '/counts',
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const scope: Prisma.ConversationWhereInput = isOversight(me.roles)
      ? {}
      : { type: { in: servableConversationTypes(me.roles) as never[] } };

    const [open, claimed, closed, mine, unassigned, mealRequests] = await Promise.all([
      prisma.conversation.count({ where: { ...scope, status: 'OPEN' } }),
      prisma.conversation.count({ where: { ...scope, status: 'CLAIMED' } }),
      prisma.conversation.count({ where: { ...scope, status: 'CLOSED' } }),
      prisma.conversation.count({ where: { assignedAdminId: me.id, status: { not: 'CLOSED' } } }),
      prisma.conversation.count({
        where: { ...scope, assignedAdminId: null, status: { not: 'CLOSED' } },
      }),
      // Meal-plan requests land in the same queue admins already watch (P-18).
      prisma.mealPlanRequest.count({ where: { status: 'PENDING' } }),
    ]);

    sendOk(res, { open, claimed, closed, mine, unassigned, pendingMealRequests: mealRequests });
  }),
);

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

adminConversationsRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(messageHistoryQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const { limit, includeDeleted } = req.query as unknown as {
      limit: number;
      includeDeleted: boolean;
    };
    const conversation = await reachableConversation(me, req.params.id);

    // Only oversight roles may see the soft-deleted rows and edit history.
    const showAll = includeDeleted && isOversight(me.roles);

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id, ...(showAll ? {} : { deletedAt: null }) },
      select: {
        ...messageSelect,
        ...(showAll
          ? {
              deletedAt: true,
              deletedByType: true,
              deletedByAdminId: true,
              purgeAfter: true,
              edits: { orderBy: { createdAt: 'asc' } },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    await prisma.message.updateMany({
      where: { conversationId: conversation.id, senderType: 'USER', readAt: null },
      data: { readAt: new Date() },
    });

    sendOk(res, {
      conversation: { ...conversation, label: CONVERSATION_LABELS[conversation.type] },
      messages: messages.reverse(),
      auditView: showAll,
    });
  }),
);

adminConversationsRouter.post(
  '/:id/claim',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const existing = await reachableConversation(me, req.params.id);

    if (existing.assignedAdminId && existing.assignedAdminId !== me.id) {
      throw AppError.conflict(`Already claimed by ${existing.assignedAdmin?.name ?? 'another admin'}`);
    }

    const conversation = await prisma.conversation.update({
      where: { id: existing.id },
      data: { assignedAdminId: me.id, status: 'CLAIMED' },
    });

    await publishRealtime(conversationRoom(conversation.id), 'conversation:claimed', {
      conversationId: conversation.id,
      admin: { id: me.id, name: me.name },
    });
    sendOk(res, { conversation });
  }),
);

adminConversationsRouter.post(
  '/:id/messages',
  validate(idParamSchema, 'params'),
  validate(sendMessageV3Schema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const conversation = await reachableConversation(me, req.params.id);
    if (conversation.status === 'CLOSED') {
      throw AppError.badRequest('This conversation is closed; reopen it before replying');
    }

    if (req.body.replyToId) {
      const quoted = await prisma.message.findFirst({
        where: { id: req.body.replyToId, conversationId: conversation.id },
        select: { id: true },
      });
      if (!quoted) throw AppError.badRequest('The quoted message is not in this conversation');
    }

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: 'ADMIN',
        senderAdminId: me.id,
        content: req.body.content,
        replyToId: req.body.replyToId ?? null,
      },
      select: messageSelect,
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: message.createdAt,
        ...(conversation.assignedAdminId ? {} : { assignedAdminId: me.id, status: 'CLAIMED' }),
      },
    });

    await publishRealtime(conversationRoom(conversation.id), 'message:new', { message });
    await publishRealtime(userRoom(conversation.userId), 'message:new', { message });
    sendOk(res, { message }, 201);
  }),
);

adminConversationsRouter.patch(
  '/:id/messages/:messageId',
  validate(messageParamsSchema, 'params'),
  validate(editMessageSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const conversation = await reachableConversation(me, req.params.id);

    const existing = await prisma.message.findFirst({
      where: { id: req.params.messageId, conversationId: conversation.id, deletedAt: null },
    });
    if (!existing) throw AppError.notFound('Message not found');
    if (existing.senderAdminId !== me.id) {
      throw AppError.forbidden('You can only edit your own messages');
    }
    if ((Date.now() - existing.createdAt.getTime()) / 60_000 > MESSAGE_EDIT_WINDOW_MINUTES) {
      throw AppError.badRequest(
        `Messages can only be edited within ${MESSAGE_EDIT_WINDOW_MINUTES} minutes of sending`,
      );
    }

    const message = await prisma.$transaction(async (tx) => {
      await tx.messageEdit.create({
        data: {
          messageId: existing.id,
          previousContent: existing.content,
          editedByAdminId: me.id,
        },
      });
      return tx.message.update({
        where: { id: existing.id },
        data: { content: req.body.content, editedAt: new Date(), editCount: { increment: 1 } },
        select: messageSelect,
      });
    });

    await publishRealtime(conversationRoom(conversation.id), 'message:edited', { message });
    sendOk(res, { message });
  }),
);

adminConversationsRouter.delete(
  '/:id/messages/:messageId',
  validate(messageParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const conversation = await reachableConversation(me, req.params.id);

    const existing = await prisma.message.findFirst({
      where: { id: req.params.messageId, conversationId: conversation.id, deletedAt: null },
      select: { id: true, senderAdminId: true },
    });
    if (!existing) throw AppError.notFound('Message not found');
    // Oversight can remove anything; a coach only their own.
    if (existing.senderAdminId !== me.id && !isOversight(me.roles)) {
      throw AppError.forbidden('You can only delete your own messages');
    }

    const now = new Date();
    await prisma.message.update({
      where: { id: existing.id },
      data: {
        deletedAt: now,
        deletedByType: 'ADMIN',
        deletedByAdminId: me.id,
        purgeAfter: new Date(now.getTime() + MESSAGE_PURGE_DAYS * 86_400_000),
      },
    });

    await publishRealtime(conversationRoom(conversation.id), 'message:deleted', {
      messageId: existing.id,
    });
    sendOk(res, { deleted: true, messageId: existing.id, purgeAfterDays: MESSAGE_PURGE_DAYS });
  }),
);

adminConversationsRouter.post(
  '/:id/messages/:messageId/reactions',
  validate(messageParamsSchema, 'params'),
  validate(reactToMessageSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const conversation = await reachableConversation(me, req.params.id);
    const message = await prisma.message.findFirst({
      where: { id: req.params.messageId, conversationId: conversation.id, deletedAt: null },
      select: { id: true },
    });
    if (!message) throw AppError.notFound('Message not found');

    const existing = await prisma.messageReaction.findFirst({
      where: { messageId: message.id, adminId: me.id, emoji: req.body.emoji },
      select: { id: true },
    });
    if (existing) await prisma.messageReaction.delete({ where: { id: existing.id } });
    else
      await prisma.messageReaction.create({
        data: { messageId: message.id, adminId: me.id, emoji: req.body.emoji },
      });

    const reactions = await prisma.messageReaction.findMany({
      where: { messageId: message.id },
      select: { emoji: true, userId: true, adminId: true },
    });

    await publishRealtime(conversationRoom(conversation.id), 'message:reactions', {
      messageId: message.id,
      reactions,
    });
    sendOk(res, { messageId: message.id, reactions, removed: Boolean(existing) });
  }),
);

// ---------------------------------------------------------------------------
// Recommendations & feedback forms
// ---------------------------------------------------------------------------

/** An admin suggests an activity/goal; the user accepts it in one tap. */
adminConversationsRouter.post(
  '/:id/recommendations',
  validate(idParamSchema, 'params'),
  validate(sendRecommendationSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const conversation = await reachableConversation(me, req.params.id);
    const { kind, payload, message: note } = req.body;

    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderType: 'ADMIN',
          senderAdminId: me.id,
          kind: 'RECOMMENDATION',
          content: note ?? `Suggested ${kind === 'GOAL' ? 'goal' : 'activity'}: ${payload.title}`,
        },
      });
      await tx.recommendation.create({
        data: {
          messageId: created.id,
          userId: conversation.userId,
          adminId: me.id,
          kind,
          payload,
        },
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: created.createdAt },
      });
      return tx.message.findUniqueOrThrow({ where: { id: created.id }, select: messageSelect });
    });

    await publishRealtime(conversationRoom(conversation.id), 'message:new', { message });
    await publishRealtime(userRoom(conversation.userId), 'message:new', { message });
    sendOk(res, { message }, 201);
  }),
);

/**
 * The weekly feedback form Support sends in-chat. The coach ids are snapshotted
 * so a later reassignment doesn't rewrite who was being rated.
 */
adminConversationsRouter.post(
  '/:id/feedback-form',
  validate(idParamSchema, 'params'),
  validate(sendFeedbackFormSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const conversation = await reachableConversation(me, req.params.id);
    const { periodStart, periodEnd, message: note, expiresInDays } = req.body;

    const assignments = await prisma.coachAssignment.findMany({
      where: { userId: conversation.userId, status: 'ACTIVE' },
      select: { role: true, adminId: true },
    });

    const existing = await prisma.feedbackForm.findUnique({
      where: { userId_periodStart: { userId: conversation.userId, periodStart: parseDateOnly(periodStart) } },
      select: { id: true, status: true },
    });
    if (existing) {
      throw AppError.conflict('A feedback form has already been sent for that week');
    }

    const form = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderType: 'ADMIN',
          senderAdminId: me.id,
          kind: 'FEEDBACK_FORM',
          content:
            note ?? 'How did this week go? A quick rating helps us look after you better.',
        },
      });
      return tx.feedbackForm.create({
        data: {
          userId: conversation.userId,
          conversationId: conversation.id,
          messageId: created.id,
          sentByAdminId: me.id,
          periodStart: parseDateOnly(periodStart),
          periodEnd: parseDateOnly(periodEnd),
          expiresAt: new Date(Date.now() + expiresInDays * 86_400_000),
          ratedLifeCoachId: assignments.find((a) => a.role === 'LIFE_COACH')?.adminId ?? null,
          ratedFitnessId: assignments.find((a) => a.role === 'FITNESS')?.adminId ?? null,
        },
      });
    });

    await publishRealtime(userRoom(conversation.userId), 'feedback:requested', { formId: form.id });
    sendOk(res, { form }, 201);
  }),
);

// ---------------------------------------------------------------------------
// Reassignment — Manager / Superadmin only
// ---------------------------------------------------------------------------

adminConversationsRouter.post(
  '/:id/reassign',
  requireOversight,
  validate(idParamSchema, 'params'),
  validate(reassignConversationSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const { toAdminId, reason } = req.body;

    const conversation = await prisma.conversation.findUnique({
      where: { id: req.params.id },
      select: { id: true, type: true, assignedAdminId: true, userId: true },
    });
    if (!conversation) throw AppError.notFound('Conversation not found');

    const target = await prisma.admin.findFirst({
      where: { id: toAdminId, deletedAt: null },
      select: { id: true, name: true, roles: true },
    });
    if (!target) throw AppError.notFound('That admin does not exist');

    // The receiving admin must actually staff this kind of conversation.
    if (!servableConversationTypes(target.roles).includes(conversation.type)) {
      throw AppError.badRequest(`${target.name} does not staff ${CONVERSATION_LABELS[conversation.type]} chats`);
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.chatReassignment.create({
        data: {
          conversationId: conversation.id,
          fromAdminId: conversation.assignedAdminId,
          toAdminId: target.id,
          byAdminId: me.id,
          reason: reason ?? null,
        },
      });
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderType: 'SYSTEM',
          kind: 'SYSTEM',
          content: `This conversation was reassigned to ${target.name}.`,
        },
      });
      return tx.conversation.update({
        where: { id: conversation.id },
        data: { assignedAdminId: target.id, status: 'CLAIMED' },
      });
    });

    await publishRealtime(conversationRoom(conversation.id), 'conversation:reassigned', {
      conversationId: conversation.id,
      to: { id: target.id, name: target.name },
    });

    sendOk(res, { conversation: updated });
  }),
);

adminConversationsRouter.get(
  '/:id/reassignments',
  requireOversight,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const reassignments = await prisma.chatReassignment.findMany({
      where: { conversationId: req.params.id },
      include: {
        fromAdmin: { select: { id: true, name: true } },
        toAdmin: { select: { id: true, name: true } },
        byAdmin: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    sendOk(res, { reassignments });
  }),
);

adminConversationsRouter.post(
  '/:id/close',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const existing = await reachableConversation(me, req.params.id);
    const conversation = await prisma.conversation.update({
      where: { id: existing.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    await publishRealtime(conversationRoom(conversation.id), 'conversation:closed', {
      conversationId: conversation.id,
    });
    sendOk(res, { conversation });
  }),
);

adminConversationsRouter.post(
  '/:id/reopen',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const existing = await reachableConversation(me, req.params.id);
    const conversation = await prisma.conversation.update({
      where: { id: existing.id },
      data: { status: existing.assignedAdminId ? 'CLAIMED' : 'OPEN', closedAt: null },
    });
    await publishRealtime(conversationRoom(conversation.id), 'conversation:reopened', {
      conversationId: conversation.id,
    });
    sendOk(res, { conversation });
  }),
);
