import { prisma } from '@life-planner/database';
import { logger } from '../logger.js';
import { sendMail } from '../mailer.js';

const BATCH_SIZE = 100;

/**
 * Dispatches due reminders. Polls PENDING reminders whose remindAt has passed,
 * delivers via the channel transport, and marks SENT/FAILED. PUSH is logged
 * (no push provider configured); EMAIL goes through the mailer. Designed to be
 * safe to run frequently — each reminder transitions out of PENDING exactly once.
 */
export async function dispatchDueReminders(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  const due = await prisma.reminder.findMany({
    where: { status: 'PENDING', remindAt: { lte: now } },
    orderBy: { remindAt: 'asc' },
    take: BATCH_SIZE,
    include: {
      activity: { select: { title: true, date: true } },
      user: { select: { email: true, name: true } },
    },
  });

  let sent = 0;
  let failed = 0;
  for (const r of due) {
    try {
      const body = r.message ?? (r.activity ? `Reminder: ${r.activity.title}` : 'You have a reminder');
      if (r.channel === 'EMAIL') {
        await sendMail({ to: r.user.email, subject: 'Life Planner reminder', text: body });
      } else {
        // PUSH: no provider wired; log so the path is observable in dev.
        logger.info({ reminderId: r.id, userId: r.userId, body }, 'push reminder (stub)');
      }
      await prisma.reminder.update({
        where: { id: r.id },
        data: { status: 'SENT', sentAt: new Date() },
      });
      sent += 1;
    } catch (err) {
      logger.error({ err, reminderId: r.id }, 'reminder dispatch failed');
      await prisma.reminder.update({ where: { id: r.id }, data: { status: 'FAILED' } });
      failed += 1;
    }
  }

  if (sent || failed) logger.info({ sent, failed }, 'reminder dispatch complete');
  return { sent, failed };
}
