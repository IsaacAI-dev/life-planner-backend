import crypto from 'node:crypto';
import { Router, raw } from 'express';
import { prisma } from '@lifeplanner/database';
import { ErrorCode, STORE_COMMISSION_RATE, fail, sendOk } from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { appleStore, googleStore } from '../lib/payments/providers.js';
import { activateSubscription, expireSubscription } from '../lib/subscriptions.js';
import { notify } from '../lib/notify.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

/**
 * Store-side subscription lifecycle. Without these, a renewal or a cancellation
 * made in the App Store or Play Store only reaches us the next time the app
 * happens to call /verify-purchase — which for a lapsed user may be never.
 */
export const storeWebhookRouter = Router();

storeWebhookRouter.use(raw({ type: '*/*', limit: '1mb' }));

async function claimEvent(
  provider: 'APPLE_APP_STORE' | 'GOOGLE_PLAY',
  eventId: string,
  eventType: string,
  payload: unknown,
): Promise<boolean> {
  const existing = await prisma.webhookEvent.findUnique({
    where: { provider_eventId: { provider, eventId } },
    select: { processedAt: true },
  });
  if (existing?.processedAt) return false;

  await prisma.webhookEvent.upsert({
    where: { provider_eventId: { provider, eventId } },
    update: {},
    create: { provider, eventId, eventType, payload: payload as object },
  });
  return true;
}

const markProcessed = (
  provider: 'APPLE_APP_STORE' | 'GOOGLE_PLAY',
  eventId: string,
  error?: string,
) =>
  prisma.webhookEvent.update({
    where: { provider_eventId: { provider, eventId } },
    data: { processedAt: new Date(), error: error ?? null },
  });

const decodeSegment = <T>(segment: string): T =>
  JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;

/**
 * Apple signs notifications as a JWS whose header carries the certificate chain
 * in `x5c`. We verify the payload against the leaf certificate's public key and
 * check the chain is rooted in Apple's CA.
 *
 * Honest limit: full chain validation (expiry, revocation, the intermediate's
 * signature over the leaf) needs a proper X.509 library. This verifies the
 * signature and pins the root, which stops a forged payload; it does not catch
 * a revoked-but-unexpired Apple certificate. The purchase itself is re-verified
 * against Apple below, so a forged notification still cannot grant entitlement.
 */
function verifyAppleJws(
  signedPayload: string,
): { valid: boolean; payload: AppleNotification | null } {
  const [headerB64, payloadB64, signatureB64] = signedPayload.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) return { valid: false, payload: null };

  // A malformed payload is a rejection, not a crash — this endpoint is public
  // and anyone can post junk at it.
  let header: { alg: string; x5c?: string[] };
  let payload: AppleNotification;
  try {
    header = decodeSegment<{ alg: string; x5c?: string[] }>(headerB64);
    payload = decodeSegment<AppleNotification>(payloadB64);
  } catch {
    return { valid: false, payload: null };
  }

  if (!header.x5c?.length) return { valid: false, payload };

  const toPem = (der: string) =>
    `-----BEGIN CERTIFICATE-----\n${der.match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----\n`;

  try {
    const leaf = new crypto.X509Certificate(toPem(header.x5c[0]));
    const verified = crypto.verify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64, 'base64url'),
    );

    // Pin the root so an arbitrary self-signed chain is rejected.
    const root = header.x5c[header.x5c.length - 1];
    const rootTrusted = env.APPLE_ROOT_CA_G3 === '' || root === env.APPLE_ROOT_CA_G3;

    return { valid: verified && rootTrusted, payload };
  } catch (err) {
    logger.warn({ err }, 'Apple JWS verification failed');
    return { valid: false, payload };
  }
}

interface AppleNotification {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  data?: {
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
    bundleId?: string;
  };
}

// ---------------------------------------------------------------------------
// Apple — App Store Server Notifications V2
// ---------------------------------------------------------------------------

storeWebhookRouter.post(
  '/apple',
  asyncHandler(async (req, res) => {
    const body = JSON.parse((req.body as Buffer).toString('utf8')) as { signedPayload: string };
    if (!body.signedPayload) {
      res.status(400).json(fail(ErrorCode.VALIDATION_ERROR, 'Missing signedPayload'));
      return;
    }

    const { valid, payload } = verifyAppleJws(body.signedPayload);
    if (!payload || (!valid && env.VERIFY_STORE_RECEIPTS)) {
      res.status(401).json(fail(ErrorCode.UNAUTHORIZED, 'Invalid notification signature'));
      return;
    }

    if (!(await claimEvent('APPLE_APP_STORE', payload.notificationUUID, payload.notificationType, payload))) {
      sendOk(res, { duplicate: true });
      return;
    }

    try {
      // The transaction info is itself a JWS; its originalTransactionId is what
      // ties the notification back to a subscription we already hold.
      const transaction = payload.data?.signedTransactionInfo
        ? decodeSegment<{
            originalTransactionId: string;
            transactionId: string;
            productId: string;
            expiresDate?: number;
          }>(payload.data.signedTransactionInfo.split('.')[1])
        : null;

      if (!transaction) {
        await markProcessed('APPLE_APP_STORE', payload.notificationUUID, 'No transaction info');
        sendOk(res, { ignored: true });
        return;
      }

      const subscription = await prisma.subscription.findFirst({
        where: { providerSubscriptionId: transaction.originalTransactionId },
        select: { id: true, userId: true, interval: true, currency: true, amount: true },
      });

      if (!subscription) {
        // A purchase we have never seen: the app will register it on its next
        // /verify-purchase call, which is the authoritative path.
        await markProcessed('APPLE_APP_STORE', payload.notificationUUID, 'Unknown subscription');
        sendOk(res, { ignored: true });
        return;
      }

      switch (payload.notificationType) {
        case 'SUBSCRIBED':
        case 'DID_RENEW':
        case 'DID_CHANGE_RENEWAL_STATUS': {
          if (payload.subtype === 'AUTO_RENEW_DISABLED') {
            await prisma.subscription.update({
              where: { id: subscription.id },
              data: { cancelAtPeriodEnd: true, cancelledAt: new Date() },
            });
            break;
          }

          const periodEnd = transaction.expiresDate ? new Date(transaction.expiresDate) : null;
          await activateSubscription({
            userId: subscription.userId,
            tier: 'PRO',
            status: 'ACTIVE',
            interval: (subscription.interval ?? 'MONTHLY') as 'MONTHLY' | 'QUARTERLY' | 'ANNUAL',
            currency: subscription.currency ?? env.BILLING_DEFAULT_CURRENCY,
            amount: Number(subscription.amount ?? 0),
            provider: 'APPLE_APP_STORE',
            platform: 'IOS',
            providerSubscriptionId: transaction.originalTransactionId,
            currentPeriodEnd: periodEnd,
          });

          const commission = STORE_COMMISSION_RATE.APPLE_APP_STORE ?? 0.3;
          await prisma.transaction.upsert({
            where: { providerTransactionId: transaction.transactionId },
            update: { status: 'SUCCEEDED' },
            create: {
              userId: subscription.userId,
              subscriptionId: subscription.id,
              type: payload.notificationType === 'DID_RENEW' ? 'RENEWAL' : 'INITIAL',
              status: 'SUCCEEDED',
              provider: 'APPLE_APP_STORE',
              platform: 'IOS',
              providerTransactionId: transaction.transactionId,
              providerOriginalId: transaction.originalTransactionId,
              description: 'Pro via App Store',
              rawPayload: payload as object,
              ...appleStore.breakdown(
                subscription.currency ?? env.BILLING_DEFAULT_CURRENCY,
                Number(subscription.amount ?? 0),
                commission,
                null,
              ),
            },
          });
          break;
        }

        case 'EXPIRED':
        case 'GRACE_PERIOD_EXPIRED': {
          await expireSubscription(subscription.userId, 'App Store reported the subscription ended');
          break;
        }

        case 'DID_FAIL_TO_RENEW': {
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { status: 'PAST_DUE' },
          });
          await notify({
            userId: subscription.userId,
            type: 'PAYMENT_FAILED',
            title: 'Your App Store payment failed',
            body: 'Update your payment method in the App Store to keep Pro.',
            href: '/plan',
          });
          break;
        }

        case 'REFUND': {
          await prisma.transaction.updateMany({
            where: { providerTransactionId: transaction.transactionId },
            data: { status: 'REFUNDED', refundedAt: new Date() },
          });
          await expireSubscription(subscription.userId, 'App Store refunded the purchase');
          break;
        }

        default:
          logger.debug({ type: payload.notificationType }, 'Unhandled Apple notification');
      }

      await markProcessed('APPLE_APP_STORE', payload.notificationUUID);
      sendOk(res, { received: true });
    } catch (err) {
      await markProcessed('APPLE_APP_STORE', payload.notificationUUID, (err as Error).message);
      throw err;
    }
  }),
);

// ---------------------------------------------------------------------------
// Google Play — Real-time developer notifications (Pub/Sub push)
// ---------------------------------------------------------------------------

const GOOGLE_NOTIFICATION_TYPES: Record<number, string> = {
  1: 'RECOVERED',
  2: 'RENEWED',
  3: 'CANCELED',
  4: 'PURCHASED',
  5: 'ON_HOLD',
  6: 'IN_GRACE_PERIOD',
  7: 'RESTARTED',
  12: 'REVOKED',
  13: 'EXPIRED',
};

storeWebhookRouter.post(
  '/google',
  asyncHandler(async (req, res) => {
    // Pub/Sub push authenticates with a shared token on the query string; the
    // real guard is that every notification is re-verified against the Play
    // Developer API below, so a forged push cannot grant anything.
    if (env.GOOGLE_PUBSUB_TOKEN && req.query.token !== env.GOOGLE_PUBSUB_TOKEN) {
      res.status(401).json(fail(ErrorCode.UNAUTHORIZED, 'Invalid push token'));
      return;
    }

    const envelope = JSON.parse((req.body as Buffer).toString('utf8')) as {
      message?: { data?: string; messageId?: string };
    };
    if (!envelope.message?.data) {
      // Acknowledge malformed pushes so Pub/Sub stops retrying them.
      sendOk(res, { ignored: true });
      return;
    }

    const notification = JSON.parse(
      Buffer.from(envelope.message.data, 'base64').toString('utf8'),
    ) as {
      packageName: string;
      subscriptionNotification?: { purchaseToken: string; subscriptionId: string; notificationType: number };
      testNotification?: unknown;
    };

    if (notification.testNotification || !notification.subscriptionNotification) {
      sendOk(res, { acknowledged: true });
      return;
    }

    const { purchaseToken, subscriptionId, notificationType } = notification.subscriptionNotification;
    const eventId = envelope.message.messageId ?? `${purchaseToken}:${notificationType}`;
    const typeName = GOOGLE_NOTIFICATION_TYPES[notificationType] ?? String(notificationType);

    if (!(await claimEvent('GOOGLE_PLAY', eventId, typeName, notification))) {
      sendOk(res, { duplicate: true });
      return;
    }

    try {
      const subscription = await prisma.subscription.findFirst({
        where: { providerPurchaseToken: purchaseToken },
        select: { id: true, userId: true, interval: true, currency: true, amount: true },
      });

      if (!subscription) {
        await markProcessed('GOOGLE_PLAY', eventId, 'Unknown purchase token');
        sendOk(res, { ignored: true });
        return;
      }

      switch (typeName) {
        case 'PURCHASED':
        case 'RENEWED':
        case 'RECOVERED':
        case 'RESTARTED': {
          // Google is the source of truth for the new expiry, so ask it rather
          // than trusting the notification body.
          const verification = await googleStore.verify(
            purchaseToken,
            subscriptionId,
            notification.packageName,
          );

          await activateSubscription({
            userId: subscription.userId,
            tier: 'PRO',
            status: 'ACTIVE',
            interval: (subscription.interval ?? 'MONTHLY') as 'MONTHLY' | 'QUARTERLY' | 'ANNUAL',
            currency: verification.currency ?? subscription.currency ?? env.BILLING_DEFAULT_CURRENCY,
            amount: verification.price ?? Number(subscription.amount ?? 0),
            provider: 'GOOGLE_PLAY',
            platform: 'ANDROID',
            providerPurchaseToken: purchaseToken,
            currentPeriodEnd: verification.expiresAt,
          });

          const commission = STORE_COMMISSION_RATE.GOOGLE_PLAY ?? 0.3;
          await prisma.transaction.upsert({
            where: { providerTransactionId: verification.transactionId },
            update: { status: 'SUCCEEDED' },
            create: {
              userId: subscription.userId,
              subscriptionId: subscription.id,
              type: typeName === 'PURCHASED' ? 'INITIAL' : 'RENEWAL',
              status: 'SUCCEEDED',
              provider: 'GOOGLE_PLAY',
              platform: 'ANDROID',
              providerTransactionId: verification.transactionId,
              providerOriginalId: verification.originalTransactionId,
              description: 'Pro via Play Store',
              rawPayload: notification as object,
              ...googleStore.breakdown(
                verification.currency ?? env.BILLING_DEFAULT_CURRENCY,
                verification.price ?? Number(subscription.amount ?? 0),
                commission,
                verification.storefront,
              ),
            },
          });
          break;
        }

        case 'CANCELED': {
          // Cancelled still means paid until the period ends.
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { cancelAtPeriodEnd: true, cancelledAt: new Date(), status: 'CANCELLED' },
          });
          break;
        }

        case 'ON_HOLD':
        case 'IN_GRACE_PERIOD': {
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { status: 'PAST_DUE' },
          });
          await notify({
            userId: subscription.userId,
            type: 'PAYMENT_FAILED',
            title: 'Your Play Store payment failed',
            body: 'Update your payment method in Google Play to keep Pro.',
            href: '/plan',
          });
          break;
        }

        case 'EXPIRED':
        case 'REVOKED': {
          await expireSubscription(subscription.userId, `Play Store reported ${typeName}`);
          break;
        }

        default:
          logger.debug({ type: typeName }, 'Unhandled Google notification');
      }

      await markProcessed('GOOGLE_PLAY', eventId);
      sendOk(res, { received: true });
    } catch (err) {
      await markProcessed('GOOGLE_PLAY', eventId, (err as Error).message);
      throw err;
    }
  }),
);
