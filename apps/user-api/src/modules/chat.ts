import { Router } from 'express';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  AppError,
  CONVERSATION_LABELS,
  ErrorCode,
  MESSAGE_EDIT_WINDOW_MINUTES,
  MESSAGE_PURGE_DAYS,
  editMessageSchema,
  idParamSchema,
  listConversationsV3QuerySchema,
  messageHistoryQuerySchema,
  openConversationSchema,
  reactToMessageSchema,
  respondRecommendationSchema,
  sendMessageV3Schema,
  sendOk,
  submitFeedbackSchema,
  voiceNoteSchema,
} from '@lifeplanner/shared-utils';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import { messageLimiter } from '../middleware/rateLimit.js';
import { emitToConversation, emitToUser } from '../realtime/socket.js';
import { getEntitlements } from '../lib/entitlements.js';
import { decodeBase64, putObject } from '../lib/storage.js';
import { buildWaveform } from '../lib/audio.js';
import { notify } from '../lib/notify.js';
import { env } from '../config/env.js';

export const chatRouter = Router();

const messageParamsSchema = z.object({ id: z.string().min(1), messageId: z.string().min(1) });

/** What a client is allowed to see: never the soft-deleted rows. */
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
  senderAdmin: { select: { id: true, name: true, avatarUrl: true } },
  senderUser: { select: { id: true, name: true, avatarUrl: true } },
  attachments: true,
  reactions: { select: { emoji: true, userId: true, adminId: true } },
  // NOTE: aggregated in serializeMessage — the client renders a count and a
  // pressed state, not one row per person.
  recommendation: {
    select: { id: true, kind: true, status: true, payload: true, createdEntityId: true },
  },
  feedbackForm: { select: { id: true, status: true, periodStart: true, periodEnd: true } },
  replyTo: {
    select: {
      id: true,
      content: true,
      senderType: true,
      deletedAt: true,
      kind: true,
      senderUser: { select: { name: true } },
      senderAdmin: { select: { name: true } },
    },
  },
} satisfies Prisma.MessageSelect;

/**
 * Aggregates raw reaction rows into what a chat UI actually draws: one entry per
 * emoji with a count and whether *you* are in it. Returning a row per person
 * would make the client group them, and every client would do it slightly
 * differently.
 */
const groupReactions = (rows: { emoji: string; userId: string | null }[], meId: string) => {
  const byEmoji = new Map<string, { emoji: string; count: number; reactedByMe: boolean }>();
  for (const row of rows) {
    const entry = byEmoji.get(row.emoji) ?? { emoji: row.emoji, count: 0, reactedByMe: false };
    entry.count += 1;
    if (row.userId === meId) entry.reactedByMe = true;
    byEmoji.set(row.emoji, entry);
  }
  return [...byEmoji.values()];
};

/** A quoted message that was later deleted shows as a tombstone, not its text. */
const serializeMessage = (m: Record<string, any>, meId = '') => ({
  ...m,
  reactions: groupReactions(m.reactions ?? [], meId),
  replyTo: m.replyTo
    ? {
        id: m.replyTo.id,
        senderType: m.replyTo.senderType,
        kind: m.replyTo.kind,
        // The quote bubble names who is being quoted.
        senderName: m.replyTo.senderUser?.name ?? m.replyTo.senderAdmin?.name ?? null,
        content: m.replyTo.deletedAt ? null : m.replyTo.content,
        deleted: Boolean(m.replyTo.deletedAt),
      }
    : null,
});

/**
 * Chats are fully behind the paywall — except SUPPORT, which every tier can
 * reach so a Free user can always raise a complaint.
 */
async function assertConversationAllowed(userId: string, type: string) {
  if (type === 'SUPPORT') return;
  const ent = await getEntitlements(userId);
  if (!ent.limits.chatEnabled) {
    throw new AppError(
      402,
      ErrorCode.FORBIDDEN,
      `${CONVERSATION_LABELS[type]} chat is part of Life Planner Pro. Support is always available on the Free plan.`,
      { upgradeRequired: true },
    );
  }
}

const ownedConversation = async (userId: string, id: string) => {
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId },
    select: { id: true, type: true, status: true, assignedAdminId: true },
  });
  if (!conversation) throw AppError.notFound('Conversation not found');
  return conversation;
};

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

chatRouter.get(
  '/conversations',
  validate(listConversationsV3QuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { type, status } = req.query as unknown as { type?: string; status?: string };

    const conversations = await prisma.conversation.findMany({
      where: {
        userId: me.id,
        ...(type ? { type: type as never } : {}),
        ...(status ? { status: status as never } : {}),
      },
      include: {
        assignedAdmin: { select: { id: true, name: true, avatarUrl: true } },
        messages: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, content: true, kind: true, senderType: true, createdAt: true },
        },
        _count: {
          select: {
            // P-19 — inbound (admin/system) messages the person has not read.
            messages: { where: { deletedAt: null, senderType: { not: 'USER' }, readAt: null } },
          },
        },
      },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    });

    const ent = await getEntitlements(me.id);

    sendOk(res, {
      conversations: conversations.map((c) => ({
        ...c,
        label: CONVERSATION_LABELS[c.type],
        unreadCount: c._count.messages,
        locked: c.type !== 'SUPPORT' && !ent.limits.chatEnabled,
        lastMessage: c.messages[0] ?? null,
        messages: undefined,
      })),
      totalUnread: conversations.reduce((sum, c) => sum + c._count.messages, 0),
    });
  }),
);

/** Global unread badge for the header. */
chatRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const rows = await prisma.conversation.findMany({
      where: { userId: me.id },
      select: {
        id: true,
        type: true,
        _count: {
          select: {
            messages: { where: { deletedAt: null, senderType: { not: 'USER' }, readAt: null } },
          },
        },
      },
    });
    sendOk(res, {
      total: rows.reduce((sum, r) => sum + r._count.messages, 0),
      byConversation: rows.map((r) => ({
        conversationId: r.id,
        type: r.type,
        unreadCount: r._count.messages,
      })),
    });
  }),
);

chatRouter.post(
  '/conversations',
  validate(openConversationSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { type, message } = req.body;
    await assertConversationAllowed(me.id, type);

    // One thread per type per user — reopened rather than duplicated.
    const conversation = await prisma.conversation.upsert({
      where: { userId_type: { userId: me.id, type } },
      update: { status: 'OPEN', closedAt: null },
      create: { userId: me.id, type, status: 'OPEN' },
      select: { id: true, type: true, status: true },
    });

    if (message) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderType: 'USER',
          senderUserId: me.id,
          content: message,
        },
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
    }

    sendOk(res, { conversation: { ...conversation, label: CONVERSATION_LABELS[conversation.type] } }, 201);
  }),
);

chatRouter.get(
  '/conversations/:id',
  validate(idParamSchema, 'params'),
  validate(messageHistoryQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { limit, before } = req.query as unknown as { limit: number; before?: string };
    const conversation = await ownedConversation(me.id, req.params.id);

    const messages = await prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        deletedAt: null,
        ...(before ? { createdAt: { lt: new Date(before) } } : {}),
      },
      select: messageSelect,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    sendOk(res, {
      conversation: { ...conversation, label: CONVERSATION_LABELS[conversation.type] },
      messages: messages.reverse().map((m) => serializeMessage(m, me.id)),
    });
  }),
);

/** P-19 */
chatRouter.post(
  '/conversations/:id/read',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const conversation = await ownedConversation(me.id, req.params.id);

    await prisma.message.updateMany({
      where: { conversationId: conversation.id, senderType: { not: 'USER' }, readAt: null },
      data: { readAt: new Date() },
    });

    sendOk(res, { conversationId: conversation.id, unreadCount: 0 });
  }),
);

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

chatRouter.post(
  '/conversations/:id/messages',
  messageLimiter,
  validate(idParamSchema, 'params'),
  validate(sendMessageV3Schema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const conversation = await ownedConversation(me.id, req.params.id);
    await assertConversationAllowed(me.id, conversation.type);

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
        senderType: 'USER',
        senderUserId: me.id,
        content: req.body.content,
        replyToId: req.body.replyToId ?? null,
      },
      select: messageSelect,
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: message.createdAt },
    });

    emitToConversation(conversation.id, 'message:new', { message: serializeMessage(message, me.id) });
    sendOk(res, { message: serializeMessage(message, me.id) }, 201);
  }),
);

/** Soft edit — the prior text is kept for audit and only oversight roles see it. */
chatRouter.patch(
  '/conversations/:id/messages/:messageId',
  validate(messageParamsSchema, 'params'),
  validate(editMessageSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const conversation = await ownedConversation(me.id, req.params.id);

    const existing = await prisma.message.findFirst({
      where: { id: req.params.messageId, conversationId: conversation.id, deletedAt: null },
    });
    if (!existing) throw AppError.notFound('Message not found');
    if (existing.senderUserId !== me.id) throw AppError.forbidden('You can only edit your own messages');
    if (existing.kind !== 'TEXT') throw AppError.badRequest('Only text messages can be edited');

    const ageMinutes = (Date.now() - existing.createdAt.getTime()) / 60_000;
    if (ageMinutes > MESSAGE_EDIT_WINDOW_MINUTES) {
      throw AppError.badRequest(
        `Messages can only be edited within ${MESSAGE_EDIT_WINDOW_MINUTES} minutes of sending`,
      );
    }

    const message = await prisma.$transaction(async (tx) => {
      await tx.messageEdit.create({
        data: {
          messageId: existing.id,
          previousContent: existing.content,
          editedByUserId: me.id,
        },
      });
      return tx.message.update({
        where: { id: existing.id },
        data: { content: req.body.content, editedAt: new Date(), editCount: { increment: 1 } },
        select: messageSelect,
      });
    });

    emitToConversation(conversation.id, 'message:edited', { message: serializeMessage(message, me.id) });
    sendOk(res, { message: serializeMessage(message, me.id) });
  }),
);

/** Soft delete with a 30-day retention window before permanent removal. */
chatRouter.delete(
  '/conversations/:id/messages/:messageId',
  validate(messageParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const conversation = await ownedConversation(me.id, req.params.id);

    const existing = await prisma.message.findFirst({
      where: { id: req.params.messageId, conversationId: conversation.id, deletedAt: null },
      select: { id: true, senderUserId: true },
    });
    if (!existing) throw AppError.notFound('Message not found');
    if (existing.senderUserId !== me.id) {
      throw AppError.forbidden('You can only delete your own messages');
    }

    const now = new Date();
    await prisma.message.update({
      where: { id: existing.id },
      data: {
        deletedAt: now,
        deletedByType: 'USER',
        purgeAfter: new Date(now.getTime() + MESSAGE_PURGE_DAYS * 86_400_000),
      },
    });

    emitToConversation(conversation.id, 'message:deleted', { messageId: existing.id });
    sendOk(res, { deleted: true, messageId: existing.id, purgeAfterDays: MESSAGE_PURGE_DAYS });
  }),
);

chatRouter.post(
  '/conversations/:id/messages/:messageId/reactions',
  validate(messageParamsSchema, 'params'),
  validate(reactToMessageSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const conversation = await ownedConversation(me.id, req.params.id);
    const message = await prisma.message.findFirst({
      where: { id: req.params.messageId, conversationId: conversation.id, deletedAt: null },
      select: { id: true },
    });
    if (!message) throw AppError.notFound('Message not found');

    // Tapping the same emoji twice removes it.
    const existing = await prisma.messageReaction.findFirst({
      where: { messageId: message.id, userId: me.id, emoji: req.body.emoji },
      select: { id: true },
    });

    if (existing) {
      await prisma.messageReaction.delete({ where: { id: existing.id } });
    } else {
      await prisma.messageReaction.create({
        data: { messageId: message.id, userId: me.id, emoji: req.body.emoji },
      });
    }

    const reactions = await prisma.messageReaction.findMany({
      where: { messageId: message.id },
      select: { emoji: true, userId: true, adminId: true },
    });

    emitToConversation(conversation.id, 'message:reactions', { messageId: message.id, reactions });
    sendOk(res, { messageId: message.id, reactions, removed: Boolean(existing) });
  }),
);

// ---------------------------------------------------------------------------
// Voice notes (P-10)
// ---------------------------------------------------------------------------

chatRouter.post(
  '/conversations/:id/voice-notes',
  messageLimiter,
  validate(idParamSchema, 'params'),
  validate(voiceNoteSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const conversation = await ownedConversation(me.id, req.params.id);

    const ent = await getEntitlements(me.id);
    if (!ent.limits.voiceNotesEnabled) {
      throw new AppError(402, ErrorCode.FORBIDDEN, 'Voice notes are part of Life Planner Pro.', {
        upgradeRequired: true,
      });
    }

    const { audioBase64, mimeType, durationSeconds, replyToId } = req.body;

    if (durationSeconds > env.VOICE_NOTE_MAX_SECONDS) {
      throw AppError.badRequest(
        `Voice notes are limited to ${Math.floor(env.VOICE_NOTE_MAX_SECONDS / 60)} minutes`,
      );
    }
    const buffer = decodeBase64(audioBase64, env.VOICE_NOTE_MAX_BYTES);

    const stored = await putObject(`voice/${me.id}`, buffer, mimeType);
    const waveform = buildWaveform(buffer);

    const message = await prisma.$transaction(async (tx) => {
      const media = await tx.mediaAsset.create({
        data: {
          kind: 'VOICE_NOTE',
          storageKey: stored.storageKey,
          url: stored.url,
          mimeType,
          sizeBytes: stored.sizeBytes,
          durationSeconds,
          checksum: stored.checksum,
          ownerUserId: me.id,
        },
      });

      const created = await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderType: 'USER',
          senderUserId: me.id,
          kind: 'VOICE_NOTE',
          content: '',
          replyToId: replyToId ?? null,
          attachments: {
            create: {
              kind: 'VOICE_NOTE',
              mediaId: media.id,
              url: stored.url,
              mimeType,
              sizeBytes: stored.sizeBytes,
              durationSeconds,
              waveform,
            },
          },
        },
        select: messageSelect,
      });

      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: created.createdAt },
      });

      return created;
    });

    emitToConversation(conversation.id, 'message:new', { message: serializeMessage(message, me.id) });
    sendOk(res, { message: serializeMessage(message, me.id) }, 201);
  }),
);

chatRouter.get(
  '/voice-notes/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const attachment = await prisma.messageAttachment.findFirst({
      where: { id: req.params.id, message: { conversation: { userId: me.id } } },
    });
    if (!attachment) throw AppError.notFound('Voice note not found');
    sendOk(res, { attachment });
  }),
);

// ---------------------------------------------------------------------------
// Recommendations & feedback
// ---------------------------------------------------------------------------

/** One-tap accept of an admin's suggested activity or goal. */
chatRouter.post(
  '/recommendations/:id/respond',
  validate(idParamSchema, 'params'),
  validate(respondRecommendationSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const recommendation = await prisma.recommendation.findFirst({
      where: { id: req.params.id, userId: me.id },
    });
    if (!recommendation) throw AppError.notFound('Recommendation not found');
    if (recommendation.status !== 'PENDING') {
      throw AppError.badRequest('You have already responded to this recommendation');
    }

    if (req.body.action === 'DISMISS') {
      const updated = await prisma.recommendation.update({
        where: { id: recommendation.id },
        data: { status: 'DISMISSED', respondedAt: new Date() },
      });
      sendOk(res, { recommendation: updated });
      return;
    }

    const payload = recommendation.payload as Record<string, string | number | undefined>;
    let createdId: string;

    if (recommendation.kind === 'GOAL') {
      const goal = await prisma.goal.create({
        data: {
          userId: me.id,
          title: String(payload.title),
          description: payload.description ? String(payload.description) : null,
          targetDate: payload.targetDate ? new Date(`${payload.targetDate}T00:00:00Z`) : null,
        },
      });
      createdId = goal.id;
    } else {
      // Accepting a suggestion still respects the quota — the coach cannot
      // spend the person's Free allowance on their behalf without them knowing.
      const ent = await getEntitlements(me.id);
      if (
        ent.limits.activitiesPerWeek !== null &&
        ent.usage.activitiesThisWeek >= ent.limits.activitiesPerWeek
      ) {
        throw new AppError(
          402,
          ErrorCode.FORBIDDEN,
          'Accepting this would exceed your weekly activity limit. Upgrade for unlimited.',
          { upgradeRequired: true },
        );
      }

      const activity = await prisma.activity.create({
        data: {
          userId: me.id,
          title: String(payload.title),
          description: payload.description ? String(payload.description) : null,
          date: payload.date ? new Date(`${payload.date}T00:00:00Z`) : null,
          windowStart: payload.windowStart ? new Date(`${payload.windowStart}T00:00:00Z`) : null,
          windowEnd: payload.windowEnd ? new Date(`${payload.windowEnd}T00:00:00Z`) : null,
          targetCount: payload.targetCount ? Number(payload.targetCount) : 1,
          startTime: payload.startTime ? String(payload.startTime) : null,
          endTime: payload.endTime ? String(payload.endTime) : null,
          history: { create: { changeType: 'CREATED', snapshot: { fromRecommendation: recommendation.id } } },
        },
      });
      createdId = activity.id;
    }

    const updated = await prisma.recommendation.update({
      where: { id: recommendation.id },
      data: { status: 'ACCEPTED', respondedAt: new Date(), createdEntityId: createdId },
    });

    emitToUser(me.id, 'recommendation:accepted', { recommendationId: updated.id, createdId });
    sendOk(res, { recommendation: updated, createdId });
  }),
);

chatRouter.get(
  '/feedback-forms',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const forms = await prisma.feedbackForm.findMany({
      where: { userId: me.id, status: 'SENT' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    sendOk(res, { forms });
  }),
);

chatRouter.post(
  '/feedback-forms/:id/respond',
  validate(idParamSchema, 'params'),
  validate(submitFeedbackSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const form = await prisma.feedbackForm.findFirst({
      where: { id: req.params.id, userId: me.id },
    });
    if (!form) throw AppError.notFound('Feedback form not found');
    if (form.status === 'COMPLETED') throw AppError.badRequest('You have already answered this form');
    if (form.expiresAt && form.expiresAt.getTime() < Date.now()) {
      await prisma.feedbackForm.update({ where: { id: form.id }, data: { status: 'EXPIRED' } });
      throw AppError.badRequest('This feedback form has expired');
    }

    const updated = await prisma.feedbackForm.update({
      where: { id: form.id },
      data: { ...req.body, status: 'COMPLETED', respondedAt: new Date() },
    });

    await notify({
      userId: me.id,
      type: 'FEEDBACK_REQUEST',
      title: 'Thanks for the feedback',
      body: 'It goes straight to the team looking after your plan.',
      href: '/chats',
    });

    sendOk(res, { form: updated });
  }),
);
