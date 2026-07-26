import type { InboxQuery } from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';

/**
 * The admin inbox (§14). Lists conversations filtered by status/channel and,
 * when assigned=me, only those claimed by the requesting admin. Ordered by most
 * recently updated, with a preview of the latest message and an unread count
 * (messages from the user not yet read by an admin).
 */
export async function listInbox(adminId: string, q: InboxQuery) {
  const where = {
    deletedAt: null,
    ...(q.status ? { status: q.status } : {}),
    ...(q.channel ? { channel: q.channel } : {}),
    ...(q.assigned === 'me' ? { assignedAdminId: adminId } : {}),
  };

  const conversations = await prisma.conversation.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: {
      user: { select: { id: true, email: true, name: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      _count: { select: { messages: { where: { role: 'USER', readAt: null } } } },
    },
  });

  return conversations.map((c) => ({
    id: c.id,
    channel: c.channel,
    status: c.status,
    title: c.title,
    assignedAdminId: c.assignedAdminId,
    user: c.user,
    lastMessage: c.messages[0]
      ? {
          id: c.messages[0].id,
          role: c.messages[0].role,
          content: c.messages[0].content,
          createdAt: c.messages[0].createdAt.toISOString(),
        }
      : null,
    unreadFromUser: c._count.messages,
    updatedAt: c.updatedAt.toISOString(),
  }));
}

/** Inbox counters for the admin console badges. */
export async function inboxCounts(adminId: string) {
  const [open, assignedToMe, closed] = await Promise.all([
    prisma.conversation.count({ where: { deletedAt: null, status: 'OPEN' } }),
    prisma.conversation.count({ where: { deletedAt: null, status: 'ASSIGNED', assignedAdminId: adminId } }),
    prisma.conversation.count({ where: { deletedAt: null, status: 'CLOSED' } }),
  ]);
  return { open, assignedToMe, closed };
}
