import {
  AppError,
  type CreateConversationInput,
  type EditMessageInput,
  type SendMessageInput,
  type MessageWire,
} from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';
import { emitMessageDeleted, emitMessageNew, emitMessageUpdated } from '../../realtime.js';
import { getDailyUsage } from '../subscriptions/subscriptions.service.js';

function toWire(m: {
  id: string;
  conversationId: string;
  role: 'USER' | 'ADMIN' | 'SYSTEM';
  adminId: string | null;
  content: string;
  readAt: Date | null;
  editedAt: Date | null;
  createdAt: Date;
}): MessageWire {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    adminId: m.adminId,
    content: m.content,
    readAt: m.readAt ? m.readAt.toISOString() : null,
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
  };
}

export async function listConversations(userId: string, channel?: 'GENERAL' | 'FITNESS_COACH') {
  return prisma.conversation.findMany({
    where: { userId, deletedAt: null, ...(channel ? { channel } : {}) },
    orderBy: { updatedAt: 'desc' },
    include: {
      messages: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
}

export async function createConversation(userId: string, input: CreateConversationInput) {
  return prisma.conversation.create({
    data: { userId, channel: input.channel, title: input.title ?? null },
  });
}

async function ownedConversation(userId: string, id: string) {
  const convo = await prisma.conversation.findFirst({
    where: { id, userId, deletedAt: null },
  });
  if (!convo) throw AppError.notFound('Conversation not found');
  return convo;
}

export async function getConversation(userId: string, id: string) {
  const convo = await ownedConversation(userId, id);
  const messages = await prisma.message.findMany({
    where: { conversationId: id, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return { conversation: convo, messages: messages.map(toWire) };
}

export async function sendMessage(userId: string, id: string, input: SendMessageInput) {
  const convo = await ownedConversation(userId, id);
  if (convo.status === 'CLOSED') throw AppError.conflict('Conversation is closed');

  // Enforce the daily free-tier message cap (subscribers bypass). Counting and
  // gating live here so the Socket.IO send path is covered too.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const usage = await getDailyUsage(userId, user?.timezone ?? 'UTC');
  if (!usage.subscribed && usage.used >= usage.limit) {
    throw AppError.limitReached(
      `Daily free message limit of ${usage.limit} reached. Subscribe for unlimited assistant messaging.`,
    );
  }

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: { conversationId: id, role: 'USER', content: input.content },
    });
    // Bump conversation so it resurfaces in admin inbox ordering.
    await tx.conversation.update({ where: { id }, data: { updatedAt: new Date() } });
    return created;
  });

  const wire = toWire(message);
  emitMessageNew(id, { message: wire });
  return wire;
}

export async function markRead(userId: string, id: string, upToMessageId: string) {
  await ownedConversation(userId, id);
  const target = await prisma.message.findFirst({
    where: { id: upToMessageId, conversationId: id },
    select: { createdAt: true },
  });
  if (!target) throw AppError.notFound('Message not found');
  // Mark admin/system messages up to that point as read by the user.
  await prisma.message.updateMany({
    where: {
      conversationId: id,
      role: { in: ['ADMIN', 'SYSTEM'] },
      readAt: null,
      createdAt: { lte: target.createdAt },
    },
    data: { readAt: new Date() },
  });
  return { ok: true };
}

/** Load a non-deleted USER message the caller owns (via the conversation). */
async function ownedUserMessage(userId: string, conversationId: string, messageId: string) {
  await ownedConversation(userId, conversationId);
  const message = await prisma.message.findFirst({
    where: { id: messageId, conversationId, deletedAt: null },
  });
  if (!message) throw AppError.notFound('Message not found');
  if (message.role !== 'USER') throw AppError.forbidden('You can only modify your own messages');
  return message;
}

export async function editMessage(
  userId: string,
  conversationId: string,
  messageId: string,
  input: EditMessageInput,
) {
  await ownedUserMessage(userId, conversationId, messageId);
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { content: input.content, editedAt: new Date() },
  });
  const wire = toWire(updated);
  emitMessageUpdated(conversationId, { message: wire });
  return wire;
}

export async function deleteMessage(userId: string, conversationId: string, messageId: string) {
  await ownedUserMessage(userId, conversationId, messageId);
  await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date() },
  });
  emitMessageDeleted(conversationId, { conversationId, messageId });
  return { deleted: true };
}

export async function deleteConversation(userId: string, id: string) {
  await ownedConversation(userId, id);
  await prisma.conversation.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return { deleted: true };
}
