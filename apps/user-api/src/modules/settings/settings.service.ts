import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  type PatchSettingsInput,
  type Settings,
} from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';

export async function getSettings(userId: string): Promise<Settings> {
  const row = await prisma.settings.findUnique({ where: { userId } });
  // Validate/normalize whatever is stored; fall back to defaults.
  return SettingsSchema.parse(row?.data ?? {});
}

/** PUT replaces the whole document (validated, unknown keys rejected by .strict()). */
export async function replaceSettings(userId: string, data: Settings): Promise<Settings> {
  const parsed = SettingsSchema.parse(data);
  const row = await prisma.settings.upsert({
    where: { userId },
    create: { userId, data: parsed },
    update: { data: parsed },
  });
  return SettingsSchema.parse(row.data);
}

/** PATCH merges into the current document then re-validates. */
export async function patchSettings(userId: string, patch: PatchSettingsInput): Promise<Settings> {
  const current = await getSettings(userId);
  const merged = SettingsSchema.parse({ ...current, ...patch, notifications: { ...current.notifications, ...patch.notifications } });
  return replaceSettings(userId, merged);
}

export { DEFAULT_SETTINGS };
