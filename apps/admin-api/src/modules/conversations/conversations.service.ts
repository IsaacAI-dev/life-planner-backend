import {
  AppError,
  type AdminRoleClaim,
  type EditMessageInput,
  type MessageWire,
  type SendMessageInput,
} from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';
import {
  emitConversationUpdated,
  emitMessageDeleted,
  emitMessageNew,
  emitMessageUpdated,
} from '../../realtime.js';

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

async function loadConversation(id: string) {
  const convo = await prisma.conversation.findFirst({ where: { id, deletedAt: null } });
  if (!convo) throw AppError.notFound('Conversation not found');
  return convo;
}

export async function getConversation(id: string) {
  const conversation = await loadConversation(id);
  const [messages, user] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId: id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.user.findUnique({
      where: { id: conversation.userId },
      select: { id: true, email: true, name: true, timezone: true },
    }),
  ]);
  return { conversation, user, messages: messages.map(toWire) };
}

/** Claim an OPEN conversation (or reassign). Idempotent if already mine. */
export async function claim(adminId: string, id: string) {
  const convo = await loadConversation(id);
  if (convo.status === 'CLOSED') throw AppError.conflict('Conversation is closed');
  if (convo.assignedAdminId && convo.assignedAdminId !== adminId) {
    throw AppError.conflict('Conversation already assigned to another admin');
  }
  const updated = await prisma.conversation.update({
    where: { id },
    data: { status: 'ASSIGNED', assignedAdminId: adminId },
  });
  emitConversationUpdated({ id, status: updated.status, assignedAdminId: updated.assignedAdminId });
  return updated;
}

/** SUPERADMIN-style explicit assignment to a specific admin. */
export async function assign(id: string, targetAdminId: string) {
  await loadConversation(id);
  const target = await prisma.admin.findUnique({ where: { id: targetAdminId }, select: { id: true } });
  if (!target) throw AppError.notFound('Target admin not found');
  const updated = await prisma.conversation.update({
    where: { id },
    data: { status: 'ASSIGNED', assignedAdminId: targetAdminId },
  });
  emitConversationUpdated({ id, status: updated.status, assignedAdminId: updated.assignedAdminId });
  return updated;
}

export async function reply(admin: { id: string; role: AdminRoleClaim }, id: string, input: SendMessageInput) {
  const convo = await loadConversation(id);
  if (convo.status === 'CLOSED') throw AppError.conflict('Conversation is closed');

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: { conversationId: id, role: 'ADMIN', adminId: admin.id, content: input.content },
    });
    // First admin reply auto-claims an unassigned conversation.
    await tx.conversation.update({
      where: { id },
      data: {
        updatedAt: new Date(),
        ...(convo.assignedAdminId ? {} : { status: 'ASSIGNED', assignedAdminId: admin.id }),
      },
    });
    return created;
  });

  const wire = toWire(message);
  emitMessageNew(id, { message: wire });
  if (!convo.assignedAdminId) {
    emitConversationUpdated({ id, status: 'ASSIGNED', assignedAdminId: admin.id });
  }
  return wire;
}

export async function close(id: string) {
  await loadConversation(id);
  const updated = await prisma.conversation.update({ where: { id }, data: { status: 'CLOSED' } });
  emitConversationUpdated({ id, status: updated.status, assignedAdminId: updated.assignedAdminId });
  return updated;
}

/** Load a non-deleted ADMIN message authored by this admin. */
async function ownAdminMessage(adminId: string, conversationId: string, messageId: string) {
  await loadConversation(conversationId);
  const message = await prisma.message.findFirst({
    where: { id: messageId, conversationId, deletedAt: null },
  });
  if (!message) throw AppError.notFound('Message not found');
  if (message.role !== 'ADMIN' || message.adminId !== adminId) {
    throw AppError.forbidden('You can only modify your own messages');
  }
  return message;
}

export async function editMessage(
  adminId: string,
  conversationId: string,
  messageId: string,
  input: EditMessageInput,
) {
  await ownAdminMessage(adminId, conversationId, messageId);
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { content: input.content, editedAt: new Date() },
  });
  const wire = toWire(updated);
  emitMessageUpdated(conversationId, { message: wire });
  return wire;
}

export async function deleteMessage(adminId: string, conversationId: string, messageId: string) {
  await ownAdminMessage(adminId, conversationId, messageId);
  await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date() },
  });
  emitMessageDeleted(conversationId, { conversationId, messageId });
  return { deleted: true };
}

/** Reopen a closed conversation: ASSIGNED if it still has an assignee, else OPEN. */
export async function reopen(id: string) {
  const convo = await loadConversation(id);
  const updated = await prisma.conversation.update({
    where: { id },
    data: { status: convo.assignedAdminId ? 'ASSIGNED' : 'OPEN' },
  });
  emitConversationUpdated({ id, status: updated.status, assignedAdminId: updated.assignedAdminId });
  return updated;
}
