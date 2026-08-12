import { Router, raw } from 'express';
import { prisma } from '@lifeplanner/database';
import { ErrorCode, fail, sendOk } from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { paddle, paystack } from '../lib/payments/providers.js';
import { activateSubscription, expireSubscription } from '../lib/subscriptions.js';
import { notify } from '../lib/notify.js';
import { logger } from '../lib/logger.js';

/**
 * Mounted outside /api/v1 and outside auth. The raw body is required for
 * signature verification, so this router parses `raw` rather than JSON.
 */
export const webhookRouter = Router();

webhookRouter.use(raw({ type: '*/*', limit: '1mb' }));

const addInterval = (from: Date, interval: string) => {
  const d = new Date(from.getTime());
  if (interval === 'QUARTERLY') d.setUTCMonth(d.getUTCMonth() + 3);
  else if (interval === 'ANNUAL') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
};

/**
 * Records the event and returns false if it has already been processed.
 * Providers retry aggressively; this unique key is what stops a renewal being
 * counted — and charged to the revenue report — twice.
 */
async function claimEvent(
  provider: 'PADDLE' | 'PAYSTACK',
  eventId: string,
  eventType: string,
  payload: unknown,
  signature?: string,
): Promise<boolean> {
  const existing = await prisma.webhookEvent.findUnique({
    where: { provider_eventId: { provider, eventId } },
    select: { processedAt: true },
  });
  if (existing?.processedAt) return false;

  await prisma.webhookEvent.upsert({
    where: { provider_eventId: { provider, eventId } },
    update: {},
    create: {
      provider,
      eventId,
      eventType,
      signature: signature ?? null,
      payload: payload as object,
    },
  });
  return true;
}

const markProcessed = (provider: 'PADDLE' | 'PAYSTACK', eventId: string, error?: string) =>
  prisma.webhookEvent.update({
    where: { provider_eventId: { provider, eventId } },
    data: { processedAt: new Date(), error: error ?? null },
  });

// ---------------------------------------------------------------------------
// Paddle
// ---------------------------------------------------------------------------

webhookRouter.post(
  '/paddle',
  asyncHandler(async (req, res) => {
    const rawBody = (req.body as Buffer).toString('utf8');
    const signature = req.header('Paddle-Signature');

    if (!paddle.verifySignature(rawBody, signature)) {
      res.status(401).json(fail(ErrorCode.UNAUTHORIZED, 'Invalid webhook signature'));
      return;
    }

    const event = JSON.parse(rawBody) as {
      event_id: string;
      event_type: string;
      data: Record<string, unknown>;
    };

    if (!(await claimEvent('PADDLE', event.event_id, event.event_type, event, signature))) {
      sendOk(res, { duplicate: true });
      return;
    }

    try {
      const data = event.data;
      const custom = (data.custom_data ?? {}) as { userId?: string; interval?: string; seats?: number };
      const userId = custom.userId;

      if (!userId) {
        await markProcessed('PADDLE', event.event_id, 'No userId in custom_data');
        sendOk(res, { ignored: true });
        return;
      }

      switch (event.event_type) {
        case 'transaction.completed': {
          const breakdown = paddle.breakdown(data);
          const interval = (custom.interval ?? 'MONTHLY') as 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
          const periodEnd = addInterval(new Date(), interval);

          const subscription = await activateSubscription({
            userId,
            tier: 'PRO',
            status: 'ACTIVE',
            interval,
            seats: custom.seats ? Number(custom.seats) : undefined,
            currency: breakdown.currency,
            amount: breakdown.grossAmount,
            provider: 'PADDLE',
            platform: 'WEB',
            providerCustomerId: (data.customer_id as string) ?? null,
            providerSubscriptionId: (data.subscription_id as string) ?? null,
            currentPeriodEnd: periodEnd,
          });

          await prisma.transaction.upsert({
            where: { providerTransactionId: data.id as string },
            update: { status: 'SUCCEEDED' },
            create: {
              userId,
              subscriptionId: subscription.id,
              type: 'INITIAL',
              status: 'SUCCEEDED',
              provider: 'PADDLE',
              platform: 'WEB',
              providerTransactionId: data.id as string,
              providerInvoiceId: (data.invoice_id as string) ?? null,
              description: `${interval} Pro via Paddle`,
              rawPayload: data as object,
              ...breakdown,
            },
          });
          break;
        }

        case 'subscription.canceled': {
          await prisma.subscription.updateMany({
            where: { userId },
            data: { cancelAtPeriodEnd: true, cancelledAt: new Date(), status: 'CANCELLED' },
          });
          break;
        }

        case 'subscription.past_due': {
          await prisma.subscription.updateMany({ where: { userId }, data: { status: 'PAST_DUE' } });
          await notify({
            userId,
            type: 'PAYMENT_FAILED',
            title: 'We could not take your payment',
            body: 'Update your card to keep Pro active.',
            href: '/plan',
          });
          break;
        }

        case 'subscription.paused':
        case 'subscription.expired': {
          await expireSubscription(userId, 'Paddle reported the subscription ended');
          break;
        }

        default:
          logger.debug({ type: event.event_type }, 'Unhandled Paddle event');
      }

      await markProcessed('PADDLE', event.event_id);
      sendOk(res, { received: true });
    } catch (err) {
      await markProcessed('PADDLE', event.event_id, (err as Error).message);
      throw err;
    }
  }),
);

// ---------------------------------------------------------------------------
// Paystack
// ---------------------------------------------------------------------------

webhookRouter.post(
  '/paystack',
  asyncHandler(async (req, res) => {
    const rawBody = (req.body as Buffer).toString('utf8');
    const signature = req.header('x-paystack-signature');

    if (!paystack.verifySignature(rawBody, signature)) {
      res.status(401).json(fail(ErrorCode.UNAUTHORIZED, 'Invalid webhook signature'));
      return;
    }

    const event = JSON.parse(rawBody) as { event: string; data: Record<string, unknown> };
    const data = event.data;
    // Paystack has no event id; the transaction reference is the stable key.
    const eventId = `${event.event}:${(data.reference as string) ?? (data.id as string)}`;

    if (!(await claimEvent('PAYSTACK', eventId, event.event, event, signature))) {
      sendOk(res, { duplicate: true });
      return;
    }

    try {
      const metadata = (data.metadata ?? {}) as {
        userId?: string;
        interval?: string;
        seats?: number;
      };
      const customer = (data.customer ?? {}) as { email?: string; customer_code?: string };

      const userId =
        metadata.userId ??
        (customer.email
          ? (await prisma.user.findUnique({ where: { email: customer.email }, select: { id: true } }))
              ?.id
          : undefined);

      if (!userId) {
        await markProcessed('PAYSTACK', eventId, 'Could not resolve a user');
        sendOk(res, { ignored: true });
        return;
      }

      switch (event.event) {
        case 'charge.success':
        case 'subscription.create': {
          const breakdown = paystack.breakdown(data);
          const interval = (metadata.interval ?? 'MONTHLY') as 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';

          const subscription = await activateSubscription({
            userId,
            tier: 'PRO',
            status: 'ACTIVE',
            interval,
            seats: metadata.seats ? Number(metadata.seats) : undefined,
            currency: breakdown.currency,
            amount: breakdown.grossAmount,
            provider: 'PAYSTACK',
            platform: 'WEB',
            providerCustomerId: customer.customer_code ?? null,
            providerSubscriptionId: (data.subscription_code as string) ?? null,
            currentPeriodEnd: addInterval(new Date(), interval),
          });

          await prisma.transaction.upsert({
            where: { providerTransactionId: String(data.reference ?? data.id) },
            update: { status: 'SUCCEEDED' },
            create: {
              userId,
              subscriptionId: subscription.id,
              type: event.event === 'subscription.create' ? 'RENEWAL' : 'INITIAL',
              status: 'SUCCEEDED',
              provider: 'PAYSTACK',
              platform: 'WEB',
              providerTransactionId: String(data.reference ?? data.id),
              description: `${interval} Pro via Paystack`,
              rawPayload: data as object,
              ...breakdown,
            },
          });
          break;
        }

        case 'invoice.payment_failed': {
          await prisma.subscription.updateMany({ where: { userId }, data: { status: 'PAST_DUE' } });
          await notify({
            userId,
            type: 'PAYMENT_FAILED',
            title: 'We could not take your payment',
            body: 'Update your card to keep Pro active.',
            href: '/plan',
          });
          break;
        }

        case 'subscription.disable':
        case 'subscription.not_renew': {
          await prisma.subscription.updateMany({
            where: { userId },
            data: { cancelAtPeriodEnd: true, status: 'CANCELLED', cancelledAt: new Date() },
          });
          break;
        }

        case 'refund.processed': {
          await prisma.transaction.updateMany({
            where: { providerTransactionId: String(data.transaction_reference ?? data.reference) },
            data: {
              status: 'REFUNDED',
              refundedAt: new Date(),
              refundedAmount: Number(data.amount ?? 0) / 100,
            },
          });
          break;
        }

        default:
          logger.debug({ type: event.event }, 'Unhandled Paystack event');
      }

      await markProcessed('PAYSTACK', eventId);
      sendOk(res, { received: true });
    } catch (err) {
      await markProcessed('PAYSTACK', eventId, (err as Error).message);
      throw err;
    }
  }),
);
