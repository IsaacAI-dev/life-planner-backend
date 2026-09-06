import { prisma } from '@lifeplanner/database';
import { MAX_SEATS, resolveProvider, seatSavingPercent } from '@lifeplanner/shared-utils';

export type Platform = 'WEB' | 'IOS' | 'ANDROID';

/**
 * Builds the plan catalog for one region.
 *
 * Extracted so the signed-in route and the public landing page cannot drift:
 * the whole point of database-driven pricing is that a price is stated once, and
 * two hand-written copies of this arithmetic would defeat that. Both routes call
 * this; the public one simply resolves its region differently.
 */
export async function buildPlanCatalog(region: string, platform: Platform) {
  const normalisedRegion = (region ?? '').toUpperCase();

  const all = await prisma.planCatalogEntry.findMany({
    where: { active: true, OR: [{ region: normalisedRegion }, { region: '' }] },
    orderBy: [{ sortOrder: 'asc' }, { seats: 'asc' }, { amount: 'asc' }],
  });

  // Region-specific rows win over the fallback for the same tier+interval+seats.
  const chosen = new Map<string, (typeof all)[number]>();
  for (const entry of all) {
    const key = `${entry.tier}:${entry.interval}:${entry.seats}`;
    const current = chosen.get(key);
    if (!current || (entry.region !== '' && current.region === '')) chosen.set(key, entry);
  }

  const countryConfig = await prisma.countryConfig.findUnique({
    where: { code: normalisedRegion || '__none__' },
    select: { currency: true, defaultProvider: true, name: true },
  });

  // An explicit CountryConfig overrides the continent-based default.
  const provider =
    (platform === 'WEB' ? countryConfig?.defaultProvider : null) ??
    resolveProvider(platform, normalisedRegion || null);

  const entries = [...chosen.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.seats - b.seats || Number(a.amount) - Number(b.amount),
  );

  const solo = new Map<string, number>();
  for (const e of entries) {
    if (e.seats === 1) solo.set(`${e.tier}:${e.interval}`, Number(e.amount));
  }

  return {
    provider,
    region: normalisedRegion || null,
    country: countryConfig?.name ?? null,
    currency: countryConfig?.currency ?? entries[0]?.currency ?? null,
    maxSeats: MAX_SEATS,
    plans: entries.map((p) => {
      const soloAmount = solo.get(`${p.tier}:${p.interval}`);
      const amount = Number(p.amount);
      return {
        tier: p.tier,
        name: p.name,
        description: p.description,
        privacyNote: p.privacyNote,
        interval: p.interval,
        seats: p.seats,
        currency: p.currency,
        amount,
        perSeatAmount: Math.round((amount / p.seats) * 100) / 100,
        savingPercent: p.seats > 1 ? seatSavingPercent(p.seats) : 0,
        savingVersusSolo:
          p.seats > 1 && soloAmount !== undefined
            ? Math.round((soloAmount * p.seats - amount) * 100) / 100
            : 0,
        highlight: p.highlight,
        features: p.features,
        productId:
          platform === 'IOS' ? p.appleProductId : platform === 'ANDROID' ? p.googleProductId : null,
      };
    }),
  };
}

/**
 * Best-effort country for a visitor who has not signed in.
 *
 * Order: an explicit `?country=`, then whatever the CDN in front of us has
 * already worked out. We do not call a geo-IP service — that is a paid
 * dependency and a round trip on the landing page, and being wrong here costs
 * only that someone sees fallback pricing until they sign in.
 *
 * `resolvedFrom` is returned so the client can say "prices shown in NGN —
 * change country" rather than pretending to certainty it does not have.
 */
export function resolveVisitorCountry(
  explicit: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): { country: string; resolvedFrom: 'QUERY' | 'EDGE' | 'FALLBACK' } {
  if (explicit) return { country: explicit.toUpperCase(), resolvedFrom: 'QUERY' };

  const header = (name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  // Cloudflare, Vercel and Fastly all publish the same thing under their own name.
  const edge =
    header('cf-ipcountry') ??
    header('x-vercel-ip-country') ??
    header('fastly-client-country') ??
    header('x-country-code');

  // Cloudflare sends XX for anonymised or unknown clients.
  if (edge && edge !== 'XX' && edge.length === 2) {
    return { country: edge.toUpperCase(), resolvedFrom: 'EDGE' };
  }

  return { country: '', resolvedFrom: 'FALLBACK' };
}
