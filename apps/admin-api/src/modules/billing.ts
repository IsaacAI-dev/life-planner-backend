import { Router } from 'express';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  paginate,
  parseDateOnly,
  revenueReportQuerySchema,
  sendOk,
  transactionQuerySchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { requireOversight } from '../middleware/auth.js';

/** Money reporting is oversight-only. */
export const billingRouter = Router();

billingRouter.use(requireOversight);

billingRouter.get(
  '/transactions',
  validate(transactionQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { from, to, provider, status, userId, page, pageSize } = req.query as unknown as {
      from?: string;
      to?: string;
      provider?: string;
      status?: string;
      userId?: string;
      page: number;
      pageSize: number;
    };

    const where: Prisma.TransactionWhereInput = {
      ...(provider ? { provider: provider as never } : {}),
      ...(status ? { status: status as never } : {}),
      ...(userId ? { userId } : {}),
      ...(from || to
        ? {
            occurredAt: {
              ...(from ? { gte: parseDateOnly(from) } : {}),
              ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { occurredAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.transaction.count({ where }),
    ]);

    sendOk(
      res,
      paginate(
        rows.map((t) => ({
          ...t,
          grossAmount: Number(t.grossAmount),
          netAmount: Number(t.netAmount),
          taxAmount: Number(t.taxAmount),
          platformFee: Number(t.platformFee),
          providerFee: Number(t.providerFee),
          payoutAmount: Number(t.payoutAmount),
          rawPayload: undefined,
        })),
        page,
        pageSize,
        total,
      ),
    );
  }),
);

/**
 * Revenue with tax, store commission and PSP fees kept separate — the whole
 * reason the Transaction row stores each rather than deriving them.
 */
billingRouter.get(
  '/revenue',
  validate(revenueReportQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { from, to, groupBy } = req.query as unknown as {
      from: string;
      to: string;
      groupBy: string;
    };

    const transactions = await prisma.transaction.findMany({
      where: {
        status: 'SUCCEEDED',
        occurredAt: { gte: parseDateOnly(from), lte: new Date(`${to}T23:59:59.999Z`) },
      },
      select: {
        occurredAt: true,
        provider: true,
        currency: true,
        billingCountry: true,
        taxCountry: true,
        grossAmount: true,
        netAmount: true,
        taxAmount: true,
        platformFee: true,
        providerFee: true,
        payoutAmount: true,
        refundedAmount: true,
      },
    });

    const keyOf = (t: (typeof transactions)[number]): string => {
      const iso = t.occurredAt.toISOString();
      switch (groupBy) {
        case 'day':
          return iso.slice(0, 10);
        case 'week': {
          const d = new Date(t.occurredAt);
          const day = (d.getUTCDay() + 6) % 7;
          d.setUTCDate(d.getUTCDate() - day);
          return d.toISOString().slice(0, 10);
        }
        case 'provider':
          return t.provider;
        case 'country':
          return t.billingCountry ?? t.taxCountry ?? 'UNKNOWN';
        case 'currency':
          return t.currency;
        case 'month':
        default:
          return iso.slice(0, 7);
      }
    };

    const buckets = new Map<string, Record<string, number>>();
    for (const t of transactions) {
      const key = keyOf(t);
      const b = buckets.get(key) ?? {
        transactions: 0,
        gross: 0,
        net: 0,
        tax: 0,
        platformFee: 0,
        providerFee: 0,
        payout: 0,
        refunded: 0,
      };
      b.transactions += 1;
      b.gross += Number(t.grossAmount);
      b.net += Number(t.netAmount);
      b.tax += Number(t.taxAmount);
      b.platformFee += Number(t.platformFee);
      b.providerFee += Number(t.providerFee);
      b.payout += Number(t.payoutAmount);
      b.refunded += Number(t.refundedAmount);
      buckets.set(key, b);
    }

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const rows = [...buckets.entries()]
      .map(([key, v]) => ({
        key,
        ...Object.fromEntries(Object.entries(v).map(([k, n]) => [k, round2(n)])),
      }))
      .sort((a, b) => String(a.key).localeCompare(String(b.key)));

    sendOk(res, {
      groupBy,
      // Mixed currencies are never summed into a single figure — that would be
      // meaningless. Totals are reported per currency.
      byCurrency: [...new Set(transactions.map((t) => t.currency))].map((currency) => {
        const subset = transactions.filter((t) => t.currency === currency);
        return {
          currency,
          gross: round2(subset.reduce((s, t) => s + Number(t.grossAmount), 0)),
          tax: round2(subset.reduce((s, t) => s + Number(t.taxAmount), 0)),
          payout: round2(subset.reduce((s, t) => s + Number(t.payoutAmount), 0)),
        };
      }),
      rows,
    });
  }),
);

billingRouter.get(
  '/subscriptions',
  asyncHandler(async (_req, res) => {
    const [byTier, byProvider, expiringSoon] = await Promise.all([
      prisma.subscription.groupBy({ by: ['tier', 'status'], _count: true }),
      prisma.subscription.groupBy({ by: ['provider'], _count: true, where: { tier: 'PRO' } }),
      prisma.subscription.count({
        where: {
          tier: 'PRO',
          status: 'ACTIVE',
          currentPeriodEnd: { gte: new Date(), lte: new Date(Date.now() + 7 * 86_400_000) },
        },
      }),
    ]);
    sendOk(res, { byTier, byProvider, expiringWithin7Days: expiringSoon });
  }),
);

/**
 * Seat occupancy across the estate. Names and emails only — the admin API has
 * no read path to a beneficiary's planner either, which is the whole point of
 * modelling seats as entitlement rather than shared ownership.
 */
billingRouter.get(
  '/seats',
  asyncHandler(async (_req, res) => {
    const [byStatus, multiSeat, unclaimed] = await Promise.all([
      prisma.subscriptionSeat.groupBy({ by: ['status'], _count: true }),
      prisma.subscription.count({ where: { seatCount: { gt: 1 }, tier: 'PRO' } }),
      prisma.subscriptionSeat.count({
        where: { status: 'INVITED', inviteExpiresAt: { lt: new Date() } },
      }),
    ]);

    const recent = await prisma.subscriptionSeat.findMany({
      where: { status: { in: ['ACTIVE', 'INVITED'] } },
      select: {
        id: true,
        inviteEmail: true,
        status: true,
        invitedAt: true,
        claimedAt: true,
        endsAt: true,
        memberUser: { select: { id: true, name: true } },
        subscription: {
          select: { seatCount: true, user: { select: { id: true, name: true, email: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    sendOk(res, {
      byStatus,
      multiSeatSubscriptions: multiSeat,
      expiredUnclaimedInvites: unclaimed,
      seats: recent.map((s) => ({
        id: s.id,
        status: s.status,
        beneficiaryEmail: s.inviteEmail,
        beneficiaryName: s.memberUser?.name ?? null,
        payer: s.subscription.user,
        planSeats: s.subscription.seatCount,
        invitedAt: s.invitedAt,
        claimedAt: s.claimedAt,
        endsAt: s.endsAt,
      })),
    });
  }),
);
