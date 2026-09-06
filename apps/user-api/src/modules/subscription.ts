import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  ErrorCode,
  MAX_SEATS,
  STORE_COMMISSION_RATE,
  cancelSubscriptionSchema,
  claimSeatSchema,
  idParamSchema,
  planCatalogQuerySchema,
  resolveProvider,
  seatCheckoutSchema,
  seatSavingPercent,
  sendOk,
  setRegionSchema,
  validateBeneficiariesSchema,
  verifyStorePurchaseSchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import { getEntitlements } from '../lib/entitlements.js';
import { activateSubscription } from '../lib/subscriptions.js';
import {
  assertBeneficiariesUsable,
  claimSeat,
  issueSeats,
  revokeSeat,
  seatForToken,
  stageSeats,
  validateBeneficiaries,
} from '../lib/seats.js';
import { appleStore, googleStore, paddle, paystack } from '../lib/payments/providers.js';
import { env } from '../config/env.js';
import { buildPlanCatalog } from '../lib/planCatalog.js';
import { logger } from '../lib/logger.js';

export const subscriptionRouter = Router();

const addInterval = (from: Date, interval: string) => {
  const d = new Date(from.getTime());
  if (interval === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (interval === 'QUARTERLY') d.setUTCMonth(d.getUTCMonth() + 3);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
};

// --- P-01 ------------------------------------------------------------------

subscriptionRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    sendOk(res, await getEntitlements(me.id));
  }),
);

// --- P-02 ------------------------------------------------------------------

/**
 * Pricing is server-owned so copy and amounts change without a client release.
 * The catalog is filtered to the caller's region, falling back to the default
 * (region = '') rows when nothing region-specific exists.
 */
subscriptionRouter.get(
  '/plans',
  validate(planCatalogQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { country, platform } = req.query as unknown as {
      country?: string;
      platform: 'WEB' | 'IOS' | 'ANDROID';
    };
    // A signed-in person's stored country wins unless they override it.
    sendOk(res, await buildPlanCatalog(country ?? me.country ?? '', platform));
  }),
);

// --- Beneficiary validation (must precede payment) --------------------------

/**
 * The payer names their beneficiaries before paying so we can refuse the sale
 * rather than take money and then fail to deliver a seat. A person with no
 * account is fine — they get emailed an invitation — but an existing Pro
 * subscriber, or a suspended or banned account, blocks checkout.
 */
subscriptionRouter.post(
  '/validate-beneficiaries',
  validate(validateBeneficiariesSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const results = await validateBeneficiaries(me.id, me.email, req.body.emails);

    sendOk(res, {
      canProceed: results.every((r) => r.ok),
      requiresInviteAcknowledgement: results.some((r) => r.willBeInvited),
      beneficiaries: results,
    });
  }),
);

// --- P-03 ------------------------------------------------------------------

subscriptionRouter.post(
  '/checkout',
  validate(seatCheckoutSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const {
      tier,
      interval,
      platform,
      country,
      successUrl,
      cancelUrl,
      seats,
      beneficiaryEmails,
      acknowledgeInvites,
    } = req.body;

    if (beneficiaryEmails.length + 1 !== seats) {
      throw AppError.badRequest(
        `A ${seats}-person plan needs ${seats - 1} beneficiary email(s); ${beneficiaryEmails.length} given`,
      );
    }

    // Re-validated server-side: the client's earlier check is a convenience,
    // not a guarantee, and state may have changed since.
    let checks: Awaited<ReturnType<typeof validateBeneficiaries>> = [];
    if (beneficiaryEmails.length > 0) {
      checks = await validateBeneficiaries(me.id, me.email, beneficiaryEmails);
      assertBeneficiariesUsable(checks);

      if (checks.some((c) => c.willBeInvited) && !acknowledgeInvites) {
        throw AppError.badRequest(
          'Some of these people do not have a Life Planner account yet. Confirm you want them invited by email, then retry with acknowledgeInvites: true.',
          ErrorCode.VALIDATION_ERROR,
          { beneficiaries: checks },
        );
      }
    }

    if (platform !== 'WEB') {
      throw AppError.badRequest(
        'Mobile purchases run through the App Store or Play Store. Complete the purchase in-app, then POST the receipt to /subscription/verify-purchase.',
      );
    }

    const region = (country ?? me.country ?? '').toUpperCase();
    const provider = resolveProvider('WEB', region || null);

    const plan =
      (await prisma.planCatalogEntry.findFirst({
        where: { tier, interval, seats, active: true, region },
      })) ??
      (await prisma.planCatalogEntry.findFirst({
        where: { tier, interval, seats, active: true, region: '' },
      }));

    if (!plan) {
      throw AppError.notFound(`A ${seats}-person ${interval.toLowerCase()} plan is not available in your region`);
    }

    const request = {
      userId: me.id,
      email: me.email,
      name: me.name,
      tier: 'PRO' as const,
      interval,
      currency: plan.currency,
      amount: Number(plan.amount),
      seats,
      country: region || null,
      providerPriceId: provider === 'PADDLE' ? plan.paddlePriceId : plan.paystackPlanId,
      successUrl,
      cancelUrl,
    };

    const session =
      provider === 'PAYSTACK'
        ? await paystack.createCheckout(request)
        : await paddle.createCheckout(request);

    // Stage the beneficiaries so the list survives the round trip to the
    // provider. Nobody is emailed and nobody is seated until payment lands.
    const subscription = await prisma.subscription.upsert({
      where: { userId: me.id },
      update: { pendingSeatCount: seats },
      create: { userId: me.id, tier: 'FREE', status: 'ACTIVE', pendingSeatCount: seats },
    });
    if (beneficiaryEmails.length > 0) {
      await stageSeats(subscription.id, beneficiaryEmails);
    }

    // The entitlement itself is only granted by the webhook — never here.
    logger.info(
      { userId: me.id, provider, reference: session.reference, seats },
      'Checkout started',
    );

    sendOk(res, {
      provider,
      checkoutUrl: session.checkoutUrl,
      reference: session.reference,
      expiresAt: session.expiresAt,
      seats,
      beneficiaries: checks.map((c) => ({ email: c.email, willBeInvited: c.willBeInvited })),
    });
  }),
);

// --- P-04 ------------------------------------------------------------------

subscriptionRouter.post(
  '/billing-portal',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const sub = await prisma.subscription.findUnique({ where: { userId: me.id } });

    if (!sub || sub.tier !== 'PRO') {
      throw AppError.badRequest('There is no active subscription to manage');
    }

    // Store subscriptions are managed by the store itself; deep-link there.
    if (sub.provider === 'APPLE_APP_STORE') {
      sendOk(res, {
        provider: sub.provider,
        portalUrl: 'https://apps.apple.com/account/subscriptions',
        managedExternally: true,
      });
      return;
    }
    if (sub.provider === 'GOOGLE_PLAY') {
      sendOk(res, {
        provider: sub.provider,
        portalUrl: `https://play.google.com/store/account/subscriptions?package=${env.GOOGLE_PACKAGE_NAME}`,
        managedExternally: true,
      });
      return;
    }
    if (sub.provider === 'PADDLE') {
      const base =
        env.PADDLE_ENV === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
      const response = await fetch(`${base}/customers/${sub.providerCustomerId}/portal-sessions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.PADDLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw AppError.internal('Could not open the billing portal');
      const json = (await response.json()) as {
        data: { urls?: { general?: { overview?: string } } };
      };
      sendOk(res, {
        provider: sub.provider,
        portalUrl: json.data.urls?.general?.overview ?? '',
        managedExternally: false,
      });
      return;
    }

    // Paystack has no hosted portal; the app manages cancellation itself.
    sendOk(res, {
      provider: sub.provider,
      portalUrl: null,
      managedExternally: false,
      message: 'Manage your plan from this page — cancel with POST /subscription/cancel.',
    });
  }),
);

// --- P-05 ------------------------------------------------------------------

subscriptionRouter.post(
  '/cancel',
  validate(cancelSubscriptionSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const sub = await prisma.subscription.findUnique({ where: { userId: me.id } });
    if (!sub || sub.tier !== 'PRO') throw AppError.badRequest('There is no active subscription to cancel');

    if (sub.provider === 'APPLE_APP_STORE' || sub.provider === 'GOOGLE_PLAY') {
      throw AppError.badRequest(
        'This subscription is billed by the app store. Cancel it from your store account and the change will sync here.',
      );
    }

    // Cancel at period end so the person keeps what they paid for.
    await prisma.subscription.update({
      where: { userId: me.id },
      data: {
        cancelAtPeriodEnd: !req.body.immediate,
        status: req.body.immediate ? 'EXPIRED' : sub.status,
        cancelledAt: new Date(),
        expiredAt: req.body.immediate ? new Date() : null,
      },
    });

    if (sub.provider === 'PAYSTACK' && sub.providerSubscriptionId) {
      await fetch('https://api.paystack.co/subscription/disable', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code: sub.providerSubscriptionId, token: sub.providerPurchaseToken }),
      }).catch((err) => logger.error({ err }, 'Paystack disable failed'));
    }

    sendOk(res, await getEntitlements(me.id));
  }),
);

// --- Mobile store purchases -------------------------------------------------

/**
 * The client never declares its own tier: it posts the store receipt and the
 * server verifies it with Apple/Google before granting anything.
 */
subscriptionRouter.post(
  '/verify-purchase',
  validate(verifyStorePurchaseSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { platform, productId, purchaseToken, packageName } = req.body;

    const verification =
      platform === 'IOS'
        ? await appleStore.verify(purchaseToken)
        : await googleStore.verify(purchaseToken, productId, packageName);

    if (!verification.valid) throw AppError.badRequest('That purchase could not be verified');

    const provider = platform === 'IOS' ? 'APPLE_APP_STORE' : 'GOOGLE_PLAY';

    // Guard against one receipt being replayed onto a second account.
    const claimed = await prisma.subscription.findFirst({
      where: { providerPurchaseToken: purchaseToken, userId: { not: me.id } },
      select: { userId: true },
    });
    if (claimed) throw AppError.conflict('That purchase is already linked to another account');

    const plan = await prisma.planCatalogEntry.findFirst({
      where: platform === 'IOS' ? { appleProductId: productId } : { googleProductId: productId },
    });

    const currency = verification.currency ?? plan?.currency ?? env.BILLING_DEFAULT_CURRENCY;
    const amount = verification.price ?? (plan ? Number(plan.amount) : 0);
    const interval = (plan?.interval ?? 'MONTHLY') as 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';

    const subscription = await activateSubscription({
      userId: me.id,
      tier: 'PRO',
      status: 'ACTIVE',
      interval,
      currency,
      amount,
      provider,
      platform: platform === 'IOS' ? 'IOS' : 'ANDROID',
      providerPurchaseToken: purchaseToken,
      providerSubscriptionId: verification.originalTransactionId,
      currentPeriodEnd: verification.expiresAt ?? addInterval(new Date(), interval),
    });

    const commission = STORE_COMMISSION_RATE[provider] ?? 0.3;
    const breakdown =
      platform === 'IOS'
        ? appleStore.breakdown(currency, amount, commission, verification.storefront)
        : googleStore.breakdown(currency, amount, commission, verification.storefront);

    await prisma.transaction.upsert({
      where: { providerTransactionId: verification.transactionId },
      update: { status: 'SUCCEEDED' },
      create: {
        userId: me.id,
        subscriptionId: subscription.id,
        type: 'INITIAL',
        status: 'SUCCEEDED',
        provider,
        platform: platform === 'IOS' ? 'IOS' : 'ANDROID',
        providerTransactionId: verification.transactionId,
        providerOriginalId: verification.originalTransactionId,
        description: `${interval} Pro via ${provider}`,
        occurredAt: verification.purchaseDate,
        rawPayload: verification.raw as object,
        ...breakdown,
      },
    });

    sendOk(res, await getEntitlements(me.id));
  }),
);

// --- Region detection -------------------------------------------------------

/**
 * Mobile reports the store front it is signed into; web reports its own guess.
 * The stored country drives both the food catalog and which web provider the
 * checkout uses, so it has one endpoint rather than being inferred twice.
 */
subscriptionRouter.put(
  '/region',
  validate(setRegionSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { country, source } = req.body;

    const user = await prisma.user.update({
      where: { id: me.id },
      data: { country, regionSource: source, regionSetAt: new Date() },
      select: { id: true, country: true, regionSource: true, regionSetAt: true },
    });

    sendOk(res, {
      ...user,
      // Tell the client immediately which rails it will be sent to.
      webProvider: resolveProvider('WEB', country),
    });
  }),
);

subscriptionRouter.get(
  '/transactions',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const transactions = await prisma.transaction.findMany({
      where: { userId: me.id, status: { in: ['SUCCEEDED', 'REFUNDED'] } },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      select: {
        id: true,
        type: true,
        status: true,
        provider: true,
        currency: true,
        grossAmount: true,
        netAmount: true,
        taxAmount: true,
        description: true,
        occurredAt: true,
        providerInvoiceId: true,
      },
    });

    sendOk(res, {
      transactions: transactions.map((t) => ({
        ...t,
        grossAmount: Number(t.grossAmount),
        netAmount: Number(t.netAmount),
        taxAmount: Number(t.taxAmount),
      })),
    });
  }),
);

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/**
 * The payer's view of their own plan. Deliberately thin: an email address, a
 * display name and a status. Nothing about what the beneficiary does in the
 * app is reachable from here — a seat is entitlement, not visibility.
 */
subscriptionRouter.get(
  '/seats',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const subscription = await prisma.subscription.findUnique({
      where: { userId: me.id },
      select: { id: true, seatCount: true, pendingSeatCount: true, currentPeriodEnd: true },
    });
    if (!subscription) {
      sendOk(res, { seatCount: 1, used: 0, available: 0, seats: [] });
      return;
    }

    const allSeats = await prisma.subscriptionSeat.findMany({
      where: { subscriptionId: subscription.id },
      select: {
        id: true,
        inviteEmail: true,
        status: true,
        invitedAt: true,
        claimedAt: true,
        revokedAt: true,
        endsAt: true,
        inviteExpiresAt: true,
        memberUser: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const seats = allSeats.filter((s) => !['EXPIRED', 'DECLINED'].includes(s.status));
    const occupied = seats.filter((s) => ['ACTIVE', 'INVITED', 'PENDING_PAYMENT'].includes(s.status));

    /**
     * Invitations that did not land, so the payer understands why a seat freed
     * up rather than watching it silently vanish.
     *
     * A declined invite reads as DECLINED whether the person simply said no or
     * reported it as unsolicited. That distinction is deliberately invisible
     * here: telling someone they have been reported would expose the reporter
     * and defeat the point of offering the report link at all. Reports go to
     * the admin abuse queue instead.
     */
    const history = allSeats
      .filter((s) => ['EXPIRED', 'DECLINED'].includes(s.status))
      .map((s) => ({
        email: s.inviteEmail,
        status: s.status,
        invitedAt: s.invitedAt,
      }));

    sendOk(res, {
      seatCount: subscription.seatCount,
      pendingSeatCount: subscription.pendingSeatCount,
      used: occupied.length,
      available: Math.max(0, subscription.seatCount - 1 - occupied.length),
      history,
      seats: seats.map((s) => ({
        id: s.id,
        email: s.inviteEmail,
        name: s.memberUser?.name ?? null,
        status: s.status,
        invitedAt: s.invitedAt,
        claimedAt: s.claimedAt,
        revokedAt: s.revokedAt,
        endsAt: s.endsAt,
        inviteExpiresAt: s.inviteExpiresAt,
      })),
    });
  }),
);

/** Fills a seat the plan already pays for but nobody occupies. */
subscriptionRouter.post(
  '/seats',
  validate(validateBeneficiariesSchema.pick({ emails: true })),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const subscription = await prisma.subscription.findUnique({
      where: { userId: me.id },
      select: { id: true, tier: true, status: true, seatCount: true },
    });

    if (!subscription || subscription.tier !== 'PRO' || subscription.status === 'EXPIRED') {
      throw AppError.badRequest('You need an active Pro plan before adding anyone to it');
    }

    const occupied = await prisma.subscriptionSeat.count({
      where: {
        subscriptionId: subscription.id,
        status: { in: ['ACTIVE', 'INVITED', 'PENDING_PAYMENT'] },
      },
    });
    const capacity = subscription.seatCount - 1;

    if (occupied + req.body.emails.length > capacity) {
      throw AppError.badRequest(
        `Your plan covers ${capacity} other ${capacity === 1 ? 'person' : 'people'} and ${occupied} ${occupied === 1 ? 'is' : 'are'} already added. Upgrade to add more.`,
        ErrorCode.VALIDATION_ERROR,
        { capacity, occupied },
      );
    }

    const checks = await validateBeneficiaries(me.id, me.email, req.body.emails);
    assertBeneficiariesUsable(checks);

    await stageSeats(subscription.id, req.body.emails);
    await issueSeats(subscription.id);

    sendOk(res, { added: checks.map((c) => ({ email: c.email, willBeInvited: c.willBeInvited })) }, 201);
  }),
);

/**
 * Removing someone. An unclaimed invitation is pulled straight away; a live
 * seat runs to the end of the paid period, because it has been paid for.
 */
subscriptionRouter.delete(
  '/seats/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const subscription = await prisma.subscription.findUnique({
      where: { userId: me.id },
      select: { id: true },
    });
    if (!subscription) throw AppError.notFound('Seat not found');

    const seat = await revokeSeat(req.params.id, subscription.id);
    sendOk(res, {
      seat: { id: seat.id, status: seat.status, endsAt: seat.endsAt },
      endsImmediately: seat.status === 'REVOKED',
    });
  }),
);

/** Preview an invitation before signing in or signing up. Unauthenticated. */
export const seatInviteRouter = Router();

seatInviteRouter.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const seat = await seatForToken(req.params.token);
    sendOk(res, {
      invitedBy: seat.subscription.user.name,
      email: seat.inviteEmail,
      expiresAt: seat.inviteExpiresAt,
      // Stated up front so nobody accepts thinking it exposes their planner.
      privacyNote:
        'They are paying for your access only. They cannot see your activities, goals, notes, budget or chats.',
    });
  }),
);

/** Accept an invitation. Requires an account, so sign-up happens first. */
subscriptionRouter.post(
  '/seats/claim',
  validate(claimSeatSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const seat = await claimSeat(req.body.token, me.id);
    sendOk(res, { seat: { id: seat.id, status: seat.status }, entitlements: await getEntitlements(me.id) });
  }),
);
