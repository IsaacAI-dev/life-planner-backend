import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  ALLOWED_IMAGE_MIME,
  selectAvatarPresetSchema,
  sendOk,
  updateExtendedProfileSchema,
  uploadAvatarSchema,
  changeCountrySchema,
  resolveProvider,
} from '@lifeplanner/shared-utils';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import { decodeBase64, deleteObject, putObject } from '../lib/storage.js';
import { env } from '../config/env.js';

export const profileRouter = Router();

const fullProfileSelect = {
  id: true,
  email: true,
  name: true,
  timezone: true,
  country: true,
  regionSource: true,
  status: true,
  avatarUrl: true,
  avatarPresetId: true,
  phone: true,
  location: true,
  state: true,
  heightCm: true,
  yearOfBirth: true,
  gender: true,
  createdAt: true,
};

/** P-06 — demographic fields, kept off the session-hot PATCH /auth/me path. */
profileRouter.patch(
  '/',
  validate(updateExtendedProfileSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const user = await prisma.user.update({
      where: { id: me.id },
      data: req.body,
      select: fullProfileSelect,
    });
    sendOk(res, { user });
  }),
);

profileRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: me.id },
      select: fullProfileSelect,
    });
    sendOk(res, { user });
  }),
);

// --- P-07 ------------------------------------------------------------------

profileRouter.post(
  '/avatar',
  validate(uploadAvatarSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { imageBase64, mimeType } = req.body;

    if (!ALLOWED_IMAGE_MIME.includes(mimeType)) {
      throw AppError.badRequest('Avatars must be JPEG, PNG or WebP');
    }
    const buffer = decodeBase64(imageBase64, env.AVATAR_MAX_BYTES);
    const stored = await putObject(`avatars/${me.id}`, buffer, mimeType);

    const user = await prisma.$transaction(async (tx) => {
      const previous = await tx.user.findUniqueOrThrow({
        where: { id: me.id },
        select: { avatarMediaId: true },
      });

      const media = await tx.mediaAsset.create({
        data: {
          kind: 'AVATAR',
          storageKey: stored.storageKey,
          url: stored.url,
          mimeType,
          sizeBytes: stored.sizeBytes,
          checksum: stored.checksum,
          ownerUserId: me.id,
        },
      });

      // Choosing an upload clears any previously selected cartoon preset.
      const updated = await tx.user.update({
        where: { id: me.id },
        data: { avatarUrl: stored.url, avatarMediaId: media.id, avatarPresetId: null },
        select: { avatarUrl: true },
      });

      if (previous.avatarMediaId) {
        await tx.mediaAsset.update({
          where: { id: previous.avatarMediaId },
          data: { deletedAt: new Date() },
        });
      }

      return updated;
    });

    sendOk(res, { avatarUrl: user.avatarUrl }, 201);
  }),
);

/** Picking one of the bundled cartoon characters instead of uploading. */
profileRouter.put(
  '/avatar/preset',
  validate(selectAvatarPresetSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const preset = await prisma.avatarPreset.findFirst({
      where: { key: req.body.presetKey, active: true },
    });
    if (!preset) throw AppError.notFound('That avatar is not available');

    const user = await prisma.user.update({
      where: { id: me.id },
      data: { avatarPresetId: preset.id, avatarUrl: preset.url, avatarMediaId: null },
      select: { avatarUrl: true, avatarPresetId: true },
    });

    sendOk(res, { ...user, preset: { key: preset.key, label: preset.label } });
  }),
);

/** Falls back to initials. */
profileRouter.delete(
  '/avatar',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const existing = await prisma.user.findUniqueOrThrow({
      where: { id: me.id },
      select: { avatarMediaId: true, avatarMedia: { select: { storageKey: true } } },
    });

    await prisma.user.update({
      where: { id: me.id },
      data: { avatarUrl: null, avatarMediaId: null, avatarPresetId: null },
    });

    if (existing.avatarMediaId) {
      await prisma.mediaAsset.update({
        where: { id: existing.avatarMediaId },
        data: { deletedAt: new Date() },
      });
      if (existing.avatarMedia) await deleteObject(existing.avatarMedia.storageKey);
    }

    sendOk(res, { avatarUrl: null });
  }),
);

// ---------------------------------------------------------------------------
// Country
// ---------------------------------------------------------------------------

/**
 * Country is normally set once, at signup. Changing it later is destructive —
 * the food catalog is per-country, so the meals someone has chosen stop
 * existing, and every amount in the app switches currency, budgets included.
 *
 * So the client asks what would happen first, shows it, and only then confirms.
 */
profileRouter.get(
  '/country/change-preview',
  validate(z.object({ country: z.string().length(2) }), 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const next = String(req.query.country).toUpperCase();

    if (next === me.country) {
      sendOk(res, { changed: false, message: 'That is already your country' });
      return;
    }

    const [currentConfig, nextConfig, selectedMeals, availableThere] = await Promise.all([
      me.country
        ? prisma.countryConfig.findUnique({ where: { code: me.country }, select: { currency: true, name: true } })
        : null,
      prisma.countryConfig.findUnique({ where: { code: next }, select: { currency: true, name: true } }),
      prisma.userFoodInventory.count({ where: { userId: me.id } }),
      prisma.foodCatalogItem.count({ where: { country: next, active: true } }),
    ]);

    if (!nextConfig) throw AppError.badRequest('Life Planner is not available in that country yet');

    const currencyChanges = (currentConfig?.currency ?? null) !== nextConfig.currency;

    const currentCurrency = currentConfig?.currency ?? null;

    /**
     * Server-authored warning lines. The numbers are also available structurally
     * below, but this dialog is destructive and a mis-read field name there
     * would render "undefined" — or worse, an empty warning that implies nothing
     * will be lost while the confirm clears their food selections. Rendering
     * these strings verbatim cannot fail that way.
     */
    const warnings: string[] = [];
    if (selectedMeals > 0) {
      warnings.push(
        `Your ${selectedMeals} selected food${selectedMeals === 1 ? '' : 's'} will be cleared — ${nextConfig.name} has its own food list.`,
      );
    }
    if (currencyChanges) {
      warnings.push(
        `Amounts across the app, including your budget, will show in ${nextConfig.currency} instead of ${currentCurrency}. Existing figures are not converted.`,
      );
    }

    sendOk(res, {
      from: me.country
        ? { country: me.country, currency: currentCurrency, name: currentConfig?.name ?? null }
        : null,
      to: { country: next, currency: nextConfig.currency, name: nextConfig.name },
      // Also flat, because these two are read inside a destructive confirm and
      // must not depend on reaching for a nested key correctly.
      currentCurrency,
      nextCurrency: nextConfig.currency,
      selectedMealsRemoved: selectedMeals,
      warnings,
      consequences: {
        // What they actually lose, as a number they can weigh.
        selectedMealsRemoved: selectedMeals,
        foodsAvailableInNewCountry: availableThere,
        currencyChanges,
        // Historic budgets are not rewritten — the amounts stay as recorded, and
        // only the symbol they are shown with changes. Say so plainly.
        budgetsRedenominated: currencyChanges,
      },
      requiresConfirmation: true,
    });
  }),
);

profileRouter.put(
  '/country',
  validate(changeCountrySchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { country, source, confirm } = req.body;

    const config = await prisma.countryConfig.findUnique({
      where: { code: country },
      select: { currency: true },
    });
    if (!config) throw AppError.badRequest('Life Planner is not available in that country yet');

    // Setting it for the first time (signup) needs no warning — there is
    // nothing yet to lose.
    const isFirstTime = !me.country;
    if (!isFirstTime && country !== me.country && !confirm) {
      throw AppError.badRequest(
        'Changing country clears your selected meals and switches your currency. Call /country/change-preview, then send confirm: true.',
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: me.id },
        data: { country, regionSource: source, regionSetAt: new Date() },
        select: { id: true, country: true, regionSource: true },
      });

      // The catalog is per-country, so the old selections point at foods that
      // are not offered here. Published meal plans are left alone — they are a
      // record of what was eaten, not a live selection.
      const removed =
        country === me.country
          ? { count: 0 }
          : await tx.userFoodInventory.deleteMany({ where: { userId: me.id } });

      return { user, removed: removed.count };
    });

    sendOk(res, {
      ...result.user,
      currency: config.currency,
      selectedMealsRemoved: result.removed,
      webProvider: resolveProvider('WEB', country),
    });
  }),
);
