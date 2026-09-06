import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  idParamSchema,
  sendOk,
  updateAdminStaffProfileSchema,
  updateSiteContentSchema,
  upsertCountryConfigSchema,
  upsertPlanEntrySchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentAdmin, requireOversight } from '../middleware/auth.js';

export const siteContentRouter = Router();
/** Admin staff profiles — who appears on the About Us page. */
export const aboutUsRouter = Router();
export const planCatalogRouter = Router();
export const avatarPresetRouter = Router();

// --- Landing-page content ---------------------------------------------------

siteContentRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const content = await prisma.siteContent.findUnique({ where: { id: 'singleton' } });
    sendOk(res, { content });
  }),
);

siteContentRouter.put(
  '/',
  requireOversight,
  validate(updateSiteContentSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const content = await prisma.siteContent.upsert({
      where: { id: 'singleton' },
      update: { ...req.body, updatedByAdminId: me.id },
      create: { id: 'singleton', ...req.body, updatedByAdminId: me.id },
    });
    sendOk(res, { content });
  }),
);

// --- About Us staff profiles (backed by Admin rows) -------------------------
//
// Rather than a separate StaffMember table, public profiles live directly on
// Admin. isPublic = true makes someone visible on the About Us page.
// All fields here are safe to serve publicly; the admin's email, passwordHash,
// roles, and operational fields are never included in public responses.

const STAFF_PUBLIC_SELECT = {
  id: true,
  name: true,
  staffRole: true,
  bio: true,
  photoUrl: true,
  favQuote: true,
  linkedIn: true,
  staffSortOrder: true,
  isPublic: true,
} as const;

/** Returns every admin (including non-public) for the console's About Us panel. */
aboutUsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const admins = await prisma.admin.findMany({
      where: { deletedAt: null },
      orderBy: [{ staffSortOrder: 'asc' }, { name: 'asc' }],
      select: {
        ...STAFF_PUBLIC_SELECT,
        // Console also needs to know status so it can label disabled admins.
        status: true,
      },
    });
    sendOk(res, { admins, publicCount: admins.filter((a) => a.isPublic).length });
  }),
);

/** Update the public profile fields on any admin. Oversight-only. */
aboutUsRouter.patch(
  '/:id',
  requireOversight,
  validate(idParamSchema, 'params'),
  validate(updateAdminStaffProfileSchema),
  asyncHandler(async (req, res) => {
    const admin = await prisma.admin.findUnique({
      where: { id: req.params.id },
      select: { id: true, deletedAt: true },
    });
    if (!admin || admin.deletedAt) throw AppError.notFound('Admin not found');

    const updated = await prisma.admin.update({
      where: { id: req.params.id },
      data: req.body,
      select: STAFF_PUBLIC_SELECT,
    });
    sendOk(res, { admin: updated });
  }),
);

// --- Plan catalog -----------------------------------------------------------

planCatalogRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const plans = await prisma.planCatalogEntry.findMany({
      orderBy: [{ sortOrder: 'asc' }, { tier: 'asc' }],
    });
    sendOk(res, { plans: plans.map((p) => ({ ...p, amount: Number(p.amount) })) });
  }),
);

/**
 * Pricing is keyed on (tier, interval, currency, region), so an upsert on that
 * tuple is the natural write — editing a price never creates a duplicate row.
 */
planCatalogRouter.put(
  '/',
  requireOversight,
  validate(upsertPlanEntrySchema),
  asyncHandler(async (req, res) => {
    const { tier, interval, currency, region, seats, ...rest } = req.body;
    const plan = await prisma.planCatalogEntry.upsert({
      where: { tier_interval_seats_currency_region: { tier, interval, seats, currency, region } },
      update: rest,
      create: { tier, interval, currency, region, seats, ...rest },
    });
    sendOk(res, { plan: { ...plan, amount: Number(plan.amount) } });
  }),
);

planCatalogRouter.delete(
  '/:id',
  requireOversight,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await prisma.planCatalogEntry.update({ where: { id: req.params.id }, data: { active: false } });
    sendOk(res, { deactivated: true });
  }),
);

// --- Cartoon avatar presets -------------------------------------------------

avatarPresetRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const presets = await prisma.avatarPreset.findMany({ orderBy: { sortOrder: 'asc' } });
    sendOk(res, { presets });
  }),
);

avatarPresetRouter.post(
  '/',
  requireOversight,
  asyncHandler(async (req, res) => {
    const { key, label, url, category, sortOrder } = req.body as Record<string, string | number>;
    if (!key || !label || !url) throw AppError.badRequest('key, label and url are required');

    const preset = await prisma.avatarPreset.upsert({
      where: { key: String(key) },
      update: { label: String(label), url: String(url), category: category ? String(category) : null },
      create: {
        key: String(key),
        label: String(label),
        url: String(url),
        category: category ? String(category) : null,
        sortOrder: Number(sortOrder ?? 0),
      },
    });
    sendOk(res, { preset }, 201);
  }),
);

avatarPresetRouter.delete(
  '/:id',
  requireOversight,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await prisma.avatarPreset.update({ where: { id: req.params.id }, data: { active: false } });
    sendOk(res, { deactivated: true });
  }),
);

// ---------------------------------------------------------------------------
// Country configuration
// ---------------------------------------------------------------------------

export const countryConfigRouter = Router();

/**
 * Currency, provider and tax vary by jurisdiction. Pricing is then set per
 * market in PlanCatalogEntry rather than derived from an FX rate — charging
 * London differently from Lagos is deliberate, not an exchange-rate artefact.
 */
countryConfigRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const countries = await prisma.countryConfig.findMany({ orderBy: { name: 'asc' } });
    sendOk(res, {
      countries: countries.map((c) => ({ ...c, taxRate: Number(c.taxRate) })),
    });
  }),
);

countryConfigRouter.put(
  '/',
  requireOversight,
  validate(upsertCountryConfigSchema),
  asyncHandler(async (req, res) => {
    const { code, ...rest } = req.body;
    const country = await prisma.countryConfig.upsert({
      where: { code },
      update: rest,
      create: { code, ...rest },
    });
    sendOk(res, { country: { ...country, taxRate: Number(country.taxRate) } });
  }),
);

countryConfigRouter.delete(
  '/:code',
  requireOversight,
  asyncHandler(async (req, res) => {
    // Deactivating rather than deleting keeps the market's price history intact.
    const country = await prisma.countryConfig.update({
      where: { code: req.params.code.toUpperCase() },
      data: { active: false },
    });
    sendOk(res, { deactivated: true, code: country.code });
  }),
);

/**
 * Every price for one market, across intervals and seat counts — the view an
 * ops person needs when setting up a new country.
 */
countryConfigRouter.get(
  '/:code/pricing',
  asyncHandler(async (req, res) => {
    const code = req.params.code.toUpperCase();
    const [country, plans] = await Promise.all([
      prisma.countryConfig.findUnique({ where: { code } }),
      prisma.planCatalogEntry.findMany({
        where: { region: code },
        orderBy: [{ interval: 'asc' }, { seats: 'asc' }],
      }),
    ]);
    if (!country) throw AppError.notFound('That country is not configured');

    sendOk(res, {
      country: { ...country, taxRate: Number(country.taxRate) },
      plans: plans.map((p) => ({
        ...p,
        amount: Number(p.amount),
        perSeatAmount: Math.round((Number(p.amount) / p.seats) * 100) / 100,
      })),
      // Flagged so ops notices a market configured but never priced.
      unpriced: plans.length === 0,
    });
  }),
);
