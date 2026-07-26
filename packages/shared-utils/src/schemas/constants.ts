/**
 * Default categories seeded per-user on registration (§6). Seeded with
 * isDefault: true so users may rename or delete them without special-casing
 * system rows.
 */
export interface DefaultCategory {
  name: string;
  color: string;
  icon: string;
}

export const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  { name: 'Fitness', color: '#2563EB', icon: 'dumbbell' },
  { name: 'Learning / Videos', color: '#DC2626', icon: 'play' },
  { name: 'Work', color: '#0891B2', icon: 'briefcase' },
  { name: 'Personal', color: '#16A34A', icon: 'user' },
  { name: 'Health', color: '#9333EA', icon: 'heart' },
  { name: 'Errands', color: '#D97706', icon: 'check-square' },
] as const;
