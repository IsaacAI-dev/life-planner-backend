import { AppError, type CreateReminderInput } from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';

/**
 * Reminders are persisted as PENDING and dispatched by the reminder job
 * (src/jobs). Creating a reminder for an activity verifies ownership.
 */
export async function createReminder(userId: string, input: CreateReminderInput) {
  if (input.activityId) {
    const activity = await prisma.activity.findFirst({
      where: { id: input.activityId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!activity) throw AppError.notFound('Activity not found');
  }

  const remindAt = new Date(input.remindAt);
  if (Number.isNaN(remindAt.getTime())) throw AppError.badRequest('Invalid remindAt');

  return prisma.reminder.create({
    data: {
      userId,
      activityId: input.activityId ?? null,
      remindAt,
      channel: input.channel,
      message: input.message ?? null,
    },
  });
}

export async function listReminders(userId: string) {
  return prisma.reminder.findMany({
    where: { userId },
    orderBy: { remindAt: 'asc' },
    include: {
      activity: { select: { id: true, title: true, date: true } },
    },
  });
}

export async function cancelReminder(userId: string, id: string) {
  const reminder = await prisma.reminder.findFirst({ where: { id, userId } });
  if (!reminder) throw AppError.notFound('Reminder not found');
  if (reminder.status !== 'PENDING') {
    throw AppError.conflict('Only pending reminders can be cancelled');
  }
  return prisma.reminder.update({
    where: { id },
    data: { status: 'CANCELLED' },
  });
}
