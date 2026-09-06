import cron from 'node-cron';
import { prisma } from '@lifeplanner/database';
import { logger } from '../lib/logger.js';
import { expireSubscription } from '../lib/subscriptions.js';
import { notify } from '../lib/notify.js';
import { expireLapsedSeats } from '../lib/seats.js';

/**
 * Permanently removes soft-deleted messages once their 30-day retention window
 * has passed. Until then a Manager or Super Admin can still read them, which is
 * the whole point of the soft delete.
 */
export function startMessagePurgeJob() {
  // 03:15 daily — off the hour to avoid the reminder sweep.
  return cron.schedule('15 3 * * *', () => {
    void (async () => {
      try {
        const { count } = await prisma.message.deleteMany({
          where: { deletedAt: { not: null }, purgeAfter: { lte: new Date() } },
        });
        if (count > 0) logger.info({ count }, 'Purged expired soft-deleted messages');
      } catch (err) {
        logger.error({ err }, 'Message purge job failed');
      }
    })();
  });
}

/**
 * Flips lapsed subscriptions to EXPIRED and releases their coaches, and warns
 * people three days out. Entitlement itself does not depend on this job having
 * run — getEntitlements treats a past currentPeriodEnd as expired at read time —
 * so a missed run degrades notifications, not correctness.
 */
export function startSubscriptionSweepJob() {
  return cron.schedule('30 2 * * *', () => {
    void (async () => {
      try {
        const now = new Date();

        const lapsed = await prisma.subscription.findMany({
          where: {
            tier: 'PRO',
            status: { in: ['ACTIVE', 'PAST_DUE', 'CANCELLED'] },
            currentPeriodEnd: { lt: now },
          },
          select: { userId: true },
        });

        for (const { userId } of lapsed) {
          await expireSubscription(userId, 'Billing period ended');
        }

        const soon = new Date(now.getTime() + 3 * 86_400_000);
        const expiring = await prisma.subscription.findMany({
          where: {
            tier: 'PRO',
            status: 'ACTIVE',
            cancelAtPeriodEnd: true,
            currentPeriodEnd: { gte: now, lte: soon },
          },
          select: { userId: true, currentPeriodEnd: true },
        });

        for (const sub of expiring) {
          // Only warn once per day per user; a duplicate title on the same day
          // is the cheapest reliable guard without another column.
          const already = await prisma.notification.findFirst({
            where: {
              userId: sub.userId,
              type: 'PLAN_EXPIRING',
              createdAt: { gte: new Date(now.getTime() - 20 * 3_600_000) },
            },
            select: { id: true },
          });
          if (already) continue;

          await notify({
            userId: sub.userId,
            type: 'PLAN_EXPIRING',
            title: 'Your Pro plan ends soon',
            body: 'Renew to keep your chats, voice notes and meal plans.',
            href: '/plan',
          });
        }

        // Seats revoked mid-period run to the end of the paid period.
        const seatsEnded = await expireLapsedSeats();

        if (lapsed.length || expiring.length || seatsEnded) {
          logger.info(
            { expired: lapsed.length, warned: expiring.length, seatsEnded },
            'Subscription sweep done',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Subscription sweep job failed');
      }
    })();
  });
}

/**
 * Lifts suspensions whose date has passed. Entitlement does not depend on this
 * running — the auth middleware already treats an elapsed suspension as lifted
 * — but flipping the row keeps the console honest and writes the
 * AUTO_REINSTATED event the moderation history needs.
 */
export function startSuspensionSweepJob() {
  return cron.schedule('0 3 * * *', () => {
    void (async () => {
      try {
        const due = await prisma.user.findMany({
          where: { status: 'SUSPENDED', suspendedUntil: { lte: new Date() } },
          select: { id: true },
        });
        if (due.length === 0) return;

        for (const { id } of due) {
          await prisma.$transaction([
            prisma.user.update({
              where: { id },
              data: {
                status: 'ACTIVE',
                statusReason: null,
                suspendedUntil: null,
                statusChangedAt: new Date(),
                // No admin: the clock did this, not a person.
                statusChangedByAdminId: null,
              },
            }),
            prisma.moderationEvent.create({
              data: { userId: id, action: 'AUTO_REINSTATED', reason: 'Suspension period ended' },
            }),
          ]);

          await notify({
            userId: id,
            type: 'REMINDER',
            title: 'Your account is active again',
            body: 'Welcome back — your suspension has ended.',
            href: '/today',
          });
        }

        logger.info({ count: due.length }, 'Lifted expired suspensions');
      } catch (err) {
        logger.error({ err }, 'Suspension sweep failed');
      }
    })();
  });
}
