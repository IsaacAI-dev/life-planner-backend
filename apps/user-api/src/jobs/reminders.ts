import cron from 'node-cron';
import { prisma } from '@lifeplanner/database';
import { logger } from '../lib/logger.js';
import { sendMail } from '../lib/mailer.js';
import { emitToUser } from '../realtime/socket.js';

/** Sends every PENDING reminder whose remindAt has passed. */
export async function dispatchDueReminders(): Promise<number> {
  const due = await prisma.reminder.findMany({
    where: { status: 'PENDING', remindAt: { lte: new Date() } },
    include: {
      user: { select: { id: true, email: true, name: true, status: true } },
      activity: { select: { id: true, title: true, date: true } },
    },
    take: 200,
  });

  let sent = 0;
  for (const reminder of due) {
    // Suspended/banned accounts stop receiving notifications.
    if (reminder.user.status !== 'ACTIVE') {
      await prisma.reminder.update({ where: { id: reminder.id }, data: { status: 'CANCELLED' } });
      continue;
    }

    const text =
      reminder.message ??
      (reminder.activity ? `Reminder: ${reminder.activity.title}` : 'You have a Life Planner reminder');

    try {
      if (reminder.channel === 'EMAIL') {
        await sendMail({ to: reminder.user.email, subject: 'Life Planner reminder', text });
      } else {
        emitToUser(reminder.userId, 'reminder:due', {
          reminderId: reminder.id,
          activityId: reminder.activityId,
          message: text,
        });
      }
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: { status: 'SENT', sentAt: new Date() },
      });
      sent += 1;
    } catch (err) {
      logger.error({ err, reminderId: reminder.id }, 'Reminder dispatch failed');
      await prisma.reminder.update({ where: { id: reminder.id }, data: { status: 'FAILED' } });
    }
  }

  if (sent > 0) logger.info({ sent }, 'Reminders dispatched');
  return sent;
}

/** Every minute. */
export const startReminderJob = () =>
  cron.schedule('* * * * *', () => {
    void dispatchDueReminders().catch((err) => logger.error({ err }, 'Reminder dispatcher failed'));
  });
