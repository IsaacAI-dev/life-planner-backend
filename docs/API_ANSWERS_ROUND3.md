# API answers — round 3

Every answer below is a **live capture** from a running backend, not a reading of
the schema. No backend code changed for this round; this is the shape data you
asked for.

Summary: the recommendation enum you inferred is correct. The seat-invite route
is wrong in two ways — URL *and* shape. Of the ten items in §3, four match your
assumption and six do not, including both of the ones you flagged as failing
silently.

---

## 1. `POST /chat/recommendations/:id/respond` — `DISMISS` is right

Your inference was correct. Confirmed by sending the old value and reading the
rejection:

```jsonc
// { "action": "DECLINE" }  ->  400
{ "code": "VALIDATION_ERROR",
  "fieldErrors": { "action": ["Invalid enum value. Expected 'ACCEPT' | 'DISMISS', received 'DECLINE'"] } }
```

`{ "action": "DISMISS" }` returns 200:

```jsonc
{ "recommendation": {
    "id", "messageId", "userId", "adminId",
    "kind": "ACTIVITY",
    "status": "DISMISSED",
    "payload": { "title": "Probe run", "date": "2026-08-11" },
    "createdEntityId": null,
    "respondedAt": "2026-08-11T03:41:13.030Z",
    "createdAt": "…" } }
```

Two notes. The wrapper is `data.recommendation`, and on **accept** the same
shape comes back with `status: "ACCEPTED"` and `createdEntityId` set to the id
of the activity or goal that was just created — that is the id to navigate to
after "Add to my plan". Responding twice returns `400`, so the buttons should
disable after the first press rather than relying on the error.

---

## 2. `GET /seat-invites/:token` — wrong URL and wrong shape

The path does not exist. It is singular, and it lives under `/public`:

```
GET /api/v1/public/seat-invite/:token        (not /seat-invites/:token)
```

`/seat-invites/:token` returns a 404 whose body is the generic "No route
matches…", which is why this looked like a shape problem rather than a routing
one.

The body is **flat**, matching the `/public/security/:token` pattern you guessed
at — no `invite` wrapper:

```jsonc
{
  "invitedBy": "Demo User",                    // not inviterName
  "email": "invitee-probe@example.com",
  "expiresAt": "2026-08-25T03:41:38.423Z",
  "privacyNote": "They are paying for your access only. They cannot see your activities, goals, notes, budget or chats."
}
```

There is no `inviterEmail` and no `planName` — deliberately. The invitee is
being told who is paying and what that does *not* give them; the plan's name and
price are the payer's business, not the invitee's.

`privacyNote` is server-authored and safe to render verbatim — it is the
reassurance that page exists to deliver. An invalid or expired token returns
`404` with `"That invitation is not valid"`, which is a fine heading to show.

---

## 3. The ten unconfirmed shapes

### Matches your assumption ✅

**`GET /food-catalog/categories`** — `data.categories`, `color` **is** present.
```jsonc
{ "categories": [ { "id", "key": "PROTEIN", "label": "Protein",
                    "color": "#DC2626", "sortOrder": 0, "createdAt" } ] }
```

**`GET /meal-plans/requests`** — `data.requests`.
```jsonc
{ "requests": [ { "id", "userId", "date": "2026-08-11", "note": "Training day",
                  "status": "PENDING" | "FULFILLED" | "DECLINED",
                  "handledByAdminId", "handledAt", "responseNote",
                  "createdAt", "updatedAt" } ] }
```

**`GET /chat/voice-notes/:id`** — `data.attachment`, and the waveform is exactly
what you hoped: a **normalised array of 32 numbers between 0 and 1**.
```jsonc
{ "attachment": { "id", "messageId", "kind": "VOICE_NOTE", "mediaId",
    "url": "http://localhost:4000/media/voice/…/….webm",
    "mimeType": "audio/webm", "sizeBytes": 9000, "durationSeconds": 12,
    "waveform": [0.94, 0.96, 0.97, …],   // length 32
    "createdAt" } }
```

**`GET /calendar-connections`** — `data.connections`, with your four fields plus
two more. No `icsUrl` or tokens are ever returned.
```jsonc
{ "connections": [ { "id", "provider": "ICS", "label": "Team calendar",
                     "syncEnabled": true, "lastSyncedAt": null,
                     "createdAt", "eventCount": 0 } ] }
```

### Differs ❌

**`GET /auth/me/profile`** — the wrapper is **`data.user`, not `data.profile`**.
```jsonc
{ "user": { "id", "email", "name", "timezone", "country": "NG",
            "regionSource": "MANUAL", "status": "ACTIVE",
            "avatarUrl": null, "avatarPresetId": null,
            "phone", "location", "state", "heightCm", "yearOfBirth",
            "gender": "FEMALE", "createdAt" } }
```

**`GET /stats/mood`** — the array is **`points`, not `mood`**, and there is a
range and an average alongside it.
```jsonc
{ "range": { "from": "2026-08-04", "to": "2026-08-11" },
  "average": 4,
  "points": [ { "date": "2026-08-10", "mood": 4 } ] }
```
Only days with a logged mood appear — this series is sparse, unlike
`/stats/daily`, which pads empty days.

**`GET /stats/categories`** — key is right; the fields are **`total` and `done`,
not `minutes` and `activityCount`**. These are activity counts, not durations.
```jsonc
{ "range": { "from", "to" },
  "categories": [ { "categoryId": "…", "name": "Work", "color": "#2563EB",
                    "total": 1, "done": 1 } ] }
```
Note the synthetic row: activities with no category come back as
`categoryId: "uncategorized"`, `name: "Uncategorized"`, `color: "#94A3B8"`. It
is not a real category id, so don't link it to a category page.

**`GET /activities/:id/sessions`** — **no `durationMinutes` on the listed
sessions.** Only `POST …/sessions/:id/stop` returns that, for the session it just
closed. The list gives aggregates instead:
```jsonc
{ "sessions": [ { "id", "activityId", "userId",
                  "startedAt", "endedAt": "…" | null, "createdAt" } ],
  "running": null,          // the open session object, or null
  "actualMinutes": 0,       // summed across closed sessions, rounded
  "plannedMinutes": 60 }    // from startTime/endTime, null if either is absent
```
Use `running` for the timer state rather than scanning for `endedAt: null`, and
compute per-row duration client-side from the timestamps if you show it.

### The two that fail silently — both differ ❌

**`GET /subscription/plans?platform=WEB`**

`PlanOption` has **no `id`**. Key a selection on `(tier, interval, seats)`.
`seats` **does** exist and carries 1, 2 and 3 as you expected.

```jsonc
{ "provider": "PAYSTACK", "region": "NG", "country": "NG",
  "currency": "NGN", "maxSeats": 3,
  "plans": [ {
    "tier": "PRO", "name": "Pro",
    "description": "Everything in Life Planner, for you. Billed every month…",
    "privacyNote": "Your planner is yours alone. Nothing is shared unless you choose to share a board.",
    "interval": "MONTHLY", "seats": 1,
    "currency": "NGN", "amount": 4500,
    "perSeatAmount": 4500,      // amount ÷ seats, for "₦4,050 each"
    "savingPercent": 0,         // versus buying that many solo plans
    "savingVersusSolo": 0,      // absolute, same currency
    "highlight": true,
    "features": [ "Your own Life Coach and Fitness Assistant", … ],
    "productId": null           // Apple/Google id; null on WEB
  } ] }
```

`maxSeats` at the top level is the ceiling to render, so the 1/2/3 selector does
not need it hardcoded.

**`GET /subscription`**

`source` exists and behaves as you expected. But there is **no `providedBy`** —
the detail sits under **`seat`** — and it is **`seatCount`, not `seats`**.

A payer:
```jsonc
{ "tier": "PRO", "status": "ACTIVE",
  "source": "OWN",
  "seat": null,
  "seatCount": 2,
  "interval": "MONTHLY", "currency": "NGN", "amount": 4500,
  "renewsAt": "…", "currentPeriodEnd": "…", "cancelAtPeriodEnd": false,
  "provider": "PAYSTACK", "platform": "WEB",
  "limits": { "activitiesPerWeek", "goals", "chatEnabled",
              "voiceNotesEnabled", "mealPlansEnabled", "supportChatEnabled" },
  "usage": { "activitiesThisWeek": 12, "goals": 3 } }
```

A seat holder:
```jsonc
{ "tier": "PRO", "status": "ACTIVE",
  "source": "SEAT",
  "seat": { "providerName": "Demo User",
            "providerEmail": "demo@lifeplanner.local",
            "seatId": "…",
            "endsAt": null },
  "seatCount": 1,
  "interval": null, "currency": null, "amount": null,
  "renewsAt": null, "currentPeriodEnd": null, "cancelAtPeriodEnd": false,
  "provider": null, "platform": null }
```

Your instinct about the failure mode was right, and the shape makes it easy to
avoid: **every billing field is `null` for a seat holder.** So the safe test for
showing Manage-billing is `source === 'OWN'`, and `seat.providerName` is what
fills "Pro provided by Demo User". `endsAt` is set only when the seat has been
revoked with a period still to run.

---

## 4. One thing you did not ask about

`GET /public/plans` — the unauthenticated pricing list — is **slimmer than the
authenticated one**, and does not carry `seats`, `description`, `privacyNote` or
`perSeatAmount`:

```jsonc
{ "plans": [ { "tier": "FREE", "name": "Free", "interval": "MONTHLY",
               "currency": "USD", "amount": 0,
               "features": [ … ], "highlight": false } ] }
```

It also only returns the fallback region (`region: ""`, USD), so a Nigerian
visitor sees dollars until they sign in.

If the marketing pricing section is meant to show the 1/2/3-seat tiers or local
currency before signup, that endpoint needs widening — it is a small change and
I'm happy to make it, but it is a product call rather than a bug, so I have left
it alone.

---

## 5. Corrections to make on the client

| # | Where | Change |
| --- | --- | --- |
| 1 | seat-claim page | URL is `/api/v1/public/seat-invite/:token` — singular, under `/public` |
| 2 | seat-claim page | Flat body: `invitedBy`, `email`, `expiresAt`, `privacyNote`. No `invite` wrapper, no `inviterEmail`, no `planName` |
| 3 | profile | `data.user`, not `data.profile` |
| 4 | mood chart | `data.points`, not `data.mood`; sparse series; `average` provided |
| 5 | category stats | `total` / `done`, not `minutes` / `activityCount`; watch the `"uncategorized"` synthetic row |
| 6 | session list | No per-session `durationMinutes`; use `running`, `actualMinutes`, `plannedMinutes` |
| 7 | plan page | `PlanOption` has no `id` — key on `(tier, interval, seats)`; `maxSeats` is at the top level |
| 8 | plan page | `subscription.seatCount`, not `seats` |
| 9 | plan page | `subscription.seat.providerName`, not `providedBy`; gate Manage-billing on `source === 'OWN'` |
| 10 | recommendations | `DISMISS` confirmed; disable both buttons after responding (second call is 400) |

Items 4, 5, 6 and 7 fail loudly (blank chart, blank list, no plan card). Items 3,
8 and 9 fail quietly, and 9 is the one that shows a seat holder a billing button
for a subscription they do not own.
