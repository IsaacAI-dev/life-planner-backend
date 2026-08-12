# API answers — round 4

One change this round: **`GET /public/plans` is now region-aware and carries the
full plan shape.** Everything else in your document I agree with as written.

Backend suite: **289 assertions, 0 failures** (17 new, covering this endpoint).

---

## 1. `/public/plans` — widened

I took the first of your two options. The second was defensible, but regional
pricing is a deliberate feature of this product — nine markets with prices set
per country, not converted — and showing a Lagos visitor USD contradicts that at
exactly the moment someone is deciding. Hiding the shared plans made it worse:
the two- and three-seat tiers are the strongest reason to pick this over a solo
planner, and they were invisible until after signup.

It now returns **the same shape as the signed-in route**, for the visitor's own
region. Both routes call one `buildPlanCatalog()` — the arithmetic exists once,
so public and private pricing cannot drift. There is an assertion comparing the
two responses field by field.

### Region resolution

Three sources, in precedence order. `resolvedFrom` tells you which was used:

| `resolvedFrom` | Source |
| --- | --- |
| `QUERY` | `?country=NG` — an explicit choice, always wins |
| `EDGE` | `cf-ipcountry`, `x-vercel-ip-country`, `fastly-client-country`, `x-country-code` |
| `FALLBACK` | Nothing usable — the default catalog (USD) |

No geo-IP service is called. That is a paid dependency and a round trip on the
landing page, and being wrong costs only that someone sees fallback pricing.
Cloudflare's `XX` (anonymised or unknown) is treated as no answer.

**Use `resolvedFrom` for the copy.** On `EDGE` or `FALLBACK`, offer a country
picker — "Prices shown in USD. Change country" — rather than asserting a
currency you inferred. On `QUERY`, the person chose, so state it plainly. Pass
their choice back as `?country=` and it becomes `QUERY`.

### Response

```jsonc
// GET /api/v1/public/plans?country=NG          (no auth)
{
  "provider": "PAYSTACK",     // which rails checkout would use
  "region": "NG",             // null on FALLBACK
  "country": "Nigeria",
  "currency": "NGN",
  "maxSeats": 3,              // the ceiling for the 1/2/3 selector
  "resolvedFrom": "QUERY",
  "plans": [ {
    "tier": "PRO", "name": "Pro",
    "description": "Cover 2 people on one bill and save about 10% each…",
    "privacyNote": "Everyone on this plan keeps a completely private planner…",
    "interval": "MONTHLY", "seats": 2,
    "currency": "NGN", "amount": 8100,
    "perSeatAmount": 4050,
    "savingPercent": 10,
    "savingVersusSolo": 900,
    "highlight": true,
    "features": [ … ],
    "productId": null          // always null here; WEB has no store id
  } ]
}
```

Identical to `GET /subscription/plans` except for the added `resolvedFrom`, so
one renderer serves both the landing page and the signed-in plan page.

Live figures for NG, monthly:

| Seats | Amount | Per seat | Saving |
| --- | --- | --- | --- |
| 1 | ₦4,500 | ₦4,500 | — |
| 2 | ₦8,100 | ₦4,050 | ₦900 (10%) |
| 3 | ₦11,250 | ₦3,750 | ₦2,250 (17%) |

`perSeatAmount` and `savingVersusSolo` are computed server-side against the solo
row in the **same currency and interval**, so the "save 10% each" line never has
to be derived client-side or hardcoded.

### Notes

- **`FALLBACK` now lists all three seat tiers too** — the shared plans are
  visible even when the region is unknown, just priced in USD.
- `?country=NIGERIA` returns 400; it is a two-letter ISO code.
- An unknown-but-valid code (`?country=AQ`) returns the fallback catalog rather
  than an error — a visitor should never see a failure on a pricing page.
- Still unauthenticated, still cacheable — but **vary the cache on
  `cf-ipcountry` and the `country` parameter**, or one visitor's currency will be
  served to the next.

---

## 2. Your two other sections — agreed, nothing to add

**Request bodies.** Your framing is right and I have nothing to correct in it.
Three rounds have verified responses, and all three real breakages were request
bodies. The Postman collection is the contract; if it drifts, those break first
and quietly. The Activities, Recurring and Chat folders are the ones to keep
accurate.

Worth adding: the API tends to name the valid set in its rejection —
`Expected 'ACCEPT' | 'DISMISS', received 'DECLINE'` — so when a body is wrong,
the 400 usually says exactly what it wanted. Reading the error body, rather than
just the status, is the fastest route to the answer.

**Deliberately not wired.** All five entries are correct, including
`verify-purchase` and `platform=IOS` being ready-but-uncalled until a native
wrapper exists. `provider: GOOGLE` on calendar connections is still a deliberate
501; ICS is the working path.

---

## 3. Your four checks, in your order

I agree with the ordering, and can confirm the backend side of each is behaving
on live data:

1. **Plan page on a seat-holder account** — confirmed: `source: "SEAT"`,
   `seat.providerName: "Demo User"`, and every billing field `null`. Gate
   Manage-billing on `source === 'OWN'`.
2. **Insights** — `/stats/categories` returns `total`/`done` counts with the
   synthetic `"uncategorized"` row; `/stats/mood` returns a sparse `points`
   array plus `average`.
3. **Seat-invite link** — `/api/v1/public/seat-invite/:token`, flat body,
   server-authored `privacyNote`.
4. **Timer** — `running` is the open session or `null`; `actualMinutes` and
   `plannedMinutes` are aggregates; no per-session `durationMinutes` in the list.

The one thing I cannot verify from here is what your screens do with any of it.
That check is still yours, and it is the right one to run next.

---

## 4. Client change for this round

One endpoint, one shape:

- `GET /public/plans` — pass `?country=` when the visitor picks one; read
  `resolvedFrom` to decide between stating the currency and offering a picker;
  render the 1/2/3 seat tiers using `seats`, `perSeatAmount` and `savingPercent`.
  Same `PlanOption` shape as the signed-in plan page, so the card component can
  be shared.

Nothing else changed.
