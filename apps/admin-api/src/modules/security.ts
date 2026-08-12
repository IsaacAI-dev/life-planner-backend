import { Router } from 'express';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  AppError,
  idParamSchema,
  paginate,
  reviewSecurityReportSchema,
  securityReportQuerySchema,
  sendOk,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentAdmin, requireOversight } from '../middleware/auth.js';

/**
 * The abuse queue behind every "this wasn't me" link. Offering people a report
 * button and then dropping the reports would be worse than not offering one, so
 * they land here for a human to work through.
 *
 * Oversight-only: reports name accounts and email addresses.
 */
export const securityRouter = Router();

securityRouter.use(requireOversight);

securityRouter.get(
  '/reports',
  validate(securityReportQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { outcome, type, reviewed, page, pageSize } = req.query as unknown as {
      outcome?: string;
      type?: string;
      reviewed?: string;
      page: number;
      pageSize: number;
    };

    const where: Prisma.SecurityActionWhereInput = {
      // Only rows somebody actually acted on; unused tokens are noise.
      outcome: outcome ? (outcome as never) : { not: null },
      ...(type ? { type: type as never } : {}),
      ...(reviewed === 'true' ? { reviewedAt: { not: null } } : {}),
      ...(reviewed === 'false' ? { reviewedAt: null } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.securityAction.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true, status: true } },
          reviewedByAdmin: { select: { id: true, name: true } },
          seat: {
            select: {
              id: true,
              status: true,
              subscription: {
                select: { user: { select: { id: true, name: true, email: true } } },
              },
            },
          },
        },
        orderBy: { respondedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.securityAction.count({ where }),
    ]);

    sendOk(
      res,
      paginate(
        rows.map((r) => ({
          id: r.id,
          type: r.type,
          outcome: r.outcome,
          email: r.email,
          note: r.note,
          respondedAt: r.respondedAt,
          ip: r.ip,
          userAgent: r.userAgent,
          account: r.user,
          // For an invite report, who sent it is the thing worth looking at.
          reportedSender: r.seat?.subscription.user ?? null,
          reviewedBy: r.reviewedByAdmin,
          reviewedAt: r.reviewedAt,
          reviewNote: r.reviewNote,
        })),
        page,
        pageSize,
        total,
      ),
    );
  }),
);

securityRouter.get(
  '/reports/counts',
  asyncHandler(async (_req, res) => {
    const [unreviewed, byType, repeatSenders] = await Promise.all([
      prisma.securityAction.count({ where: { outcome: 'REPORTED', reviewedAt: null } }),
      prisma.securityAction.groupBy({
        by: ['type'],
        _count: true,
        where: { outcome: 'REPORTED' },
      }),
      // Someone whose invitations are repeatedly reported is the signal that
      // matters most — one report is noise, five is a pattern.
      prisma.securityAction.findMany({
        where: { outcome: 'REPORTED', type: 'SEAT_INVITE' },
        select: { seat: { select: { subscription: { select: { userId: true } } } } },
      }),
    ]);

    const tally = new Map<string, number>();
    for (const row of repeatSenders) {
      const id = row.seat?.subscription.userId;
      if (id) tally.set(id, (tally.get(id) ?? 0) + 1);
    }

    sendOk(res, {
      unreviewed,
      byType,
      repeatOffenders: [...tally.entries()]
        .filter(([, count]) => count > 1)
        .map(([userId, count]) => ({ userId, reports: count }))
        .sort((a, b) => b.reports - a.reports),
    });
  }),
);

securityRouter.post(
  '/reports/:id/review',
  validate(idParamSchema, 'params'),
  validate(reviewSecurityReportSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const existing = await prisma.securityAction.findUnique({
      where: { id: req.params.id },
      select: { id: true, outcome: true },
    });
    if (!existing) throw AppError.notFound('Report not found');
    if (!existing.outcome) throw AppError.badRequest('That link has not been acted on');

    const report = await prisma.securityAction.update({
      where: { id: existing.id },
      data: {
        reviewedByAdminId: me.id,
        reviewedAt: new Date(),
        reviewNote: req.body.reviewNote ?? null,
      },
    });
    sendOk(res, { report });
  }),
);
