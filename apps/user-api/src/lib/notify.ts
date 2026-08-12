import { prisma, type Prisma } from '@lifeplanner/database';
import { emitToUser } from '../realtime/socket.js';

type NotificationType = Prisma.NotificationCreateInput['type'];

/**
 * Single entry point for the notification centre. Writes the row and pushes a
 * `notification:new` socket event, so the header badge updates without waiting
 * for the two-minute poll.
 */
export async function notify(params: {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  href?: string;
  metadata?: Prisma.InputJsonValue;
}) {
  const notification = await prisma.notification.create({
    data: {
      userId: params.userId,
      type: params.type,
      title: params.title,
      body: params.body ?? null,
      href: params.href ?? null,
      metadata: params.metadata,
    },
  });
  emitToUser(params.userId, 'notification:new', { notification });
  return notification;
}
