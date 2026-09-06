# Marketing site endpoints — built

All seven are live on the user-api under `/api/v1/public/`, unauthenticated,
alongside `/public/content` and `/public/plans`. Every one of them is now
backed by a table you can edit from the admin console rather than by anything
hard-coded, so none of this needs a backend deploy to change.

Built in the priority order you set: the contact form and the careers list
first, then consent, then the presentation endpoints.

---

## One thing to check before you wire up

**Every response is wrapped in the standard envelope**, same as
`/public/content` and `/public/plans`:

```jsonc
{ "success": true, "data": { /* the shapes in your brief */ } }
```

The shapes below are what sits inside `data` — they match your document field
for field. Errors are `{ "success": false, "error": { "code", "message" } }`.

---

## What each endpoint does

### 1. `GET /public/marketing-assets`

Exactly the shape you specified. Notes on the parts that were decisions:

- **The five screen keys are guaranteed**, in your order (`today`, `calendar`,
  `goals`, `boards`, `chat`), present with `imageUrl: null` whether or not
  anyone has uploaded anything. The array's shape never depends on how much of
  the console has been filled in. If a sixth screen is ever added it appends
  after the fixed five rather than displacing them, and the admin API rejects
  screen keys outside your list, so a typo in the console can't silently empty
  a slot.
- **Portrait names are stored verbatim** and emitted as `name` — the five
  testimonial names and four team names from your brief are seeded exactly as
  written, accents included. Internally each row also has a stable slug key
  (`tomas-ferreira`), so if you'd rather match on an id later, say the word and
  we'll add it to the payload without changing the names.
- `null` everywhere it can be. A slot with no image is a row that exists with
  an empty `imageUrl`, not a missing row — that's deliberate, it's how the
  console knows a slot is still unfilled and how you keep your placeholder.
- **Alt text is stored but not yet returned.** There's an `alt` field on every
  asset. Tell us if you want it in the payload and it's a one-line change.

### 2. `GET /public/faqs`

Rows now, not a JSON blob, so a single answer can be corrected without
rewriting the list, and ordering is data rather than array position.

While the new table is empty it falls back to the old `SiteContent.faqs` list,
so the section can't go blank mid-changeover. Seeded with seven entries,
including yours verbatim.

### 3. `GET /public/contact`

Reads the existing `SiteContent` singleton rather than creating a second place
where the company address lives. `supportHours` is new on that record;
`officeAddress` maps to `contactAddress` and is `null` when unset, which is what
hides the row. `email` falls back to the support address if the public one
isn't set.

### 4. `GET /public/careers/roles`

Published roles only, ordered. An empty list is returned as an empty list — no
padding, no fallback, and unpublished drafts never appear. The count you use in
the headline is just `roles.length` and it will be right.

Two notes:

- **`compensation` is nullable.** Not every role has a published band when it
  opens. If the role card can't render without one, tell us and we'll make it
  required instead.
- **`id` is a cuid** (`cmsq…`), not the `role_engineer_senior` style in your
  example. It's stable and unique; if you need a human-readable slug for
  deep-linking to a role, that's worth adding deliberately rather than
  overloading the id.

### 5. `GET /public/app-links`

A platform reads as `null` unless it's active *and* has both a URL and a badge
image — half a badge isn't renderable, and pointing at a store page for an app
that doesn't exist is worse than showing nothing. No rows are seeded, so the
badge row stays hidden, which is the truthful state today.

### 6. `GET /public/legal/consent`

Versioned rather than edited in place: someone signed up under a specific
wording, and rewriting the row they agreed to would quietly erase that. The
endpoint serves the most recently published version.

**It 404s when nothing is published**, rather than inventing a summary — your
generic "I agree to the" fallback is the right thing to show then. Seeded with
version `2026-08-02` and the summary as a lead-in fragment, no trailing period.

### 7. `POST /public/contact-submissions`

Messages reach a real table and a real inbox in the admin console, and a
notification email goes to the support address on the site record.

- Returns `201` with `{ id, receivedAt }`.
- **The email is fire-and-forget.** A flaky mail transport can't turn a message
  we've safely stored into an error the sender sees; the row is the record.
  Conversely, if the mail fails it's logged loudly, because the message exists
  but nobody has been told about it.
- **A double-clicked Send returns the first submission** rather than creating a
  second ticket or erroring — same email, same message, within two minutes.
- Server-side validation mirrors yours (name, email, message, and `topic` must
  be one of your six options exactly). Malformed payloads get a `400` with
  details; as you say, they shouldn't be the common case.
- Rate limited to 5 sends per 10 minutes per IP, returning `429`. Worth knowing
  if you ever test the form in a loop.

---

## Caching and limits

The six GETs send `Cache-Control: public, max-age=60`. Long enough to absorb a
traffic spike, short enough that someone editing copy sees their change while
they're still looking at the page. Say if that's inconvenient for previews.

These routes sit outside the authenticated API's limiter, so they have their
own: 240 requests/minute per IP across the marketing GETs, and the tighter
contact-form bucket above.

---

## Admin CRUD (`/admin/v1/`, admin token)

Every resource is fully managed, not just readable. Reads are open to any
admin; writes are oversight-only (Manager or Super Admin), matching the rest of
the site content. The contact inbox is the exception — triaging it is support
work, so any admin can read and update it, and only oversight can delete.

| Resource | Routes |
| --- | --- |
| Marketing assets | `GET /marketing-assets` · `PUT /marketing-assets` (upsert on slot+key) · `PATCH /marketing-assets/:id` · `DELETE /marketing-assets/:id/image` (clears the image, keeps the slot) · `DELETE /marketing-assets/:id` |
| FAQs | `GET /faqs` · `POST /faqs` · `PATCH /faqs/:id` · `PUT /faqs/order` · `DELETE /faqs/:id` |
| Contact details | existing `GET /site-content` · `PUT /site-content` (now includes `supportHours`) |
| Career roles | `GET /careers/roles` (paginated, filterable, with `publishedCount`) · `GET /careers/roles/:id` · `POST` · `PATCH /:id` · `PUT /careers/roles/order` · `DELETE /:id` |
| App links | `GET /app-links` · `PUT /app-links` (upsert per platform) · `PATCH /app-links/:platform` · `DELETE /app-links/:platform` |
| Legal consent | `GET /legal/consent` (all versions + current) · `POST` (new version, optionally published) · `PATCH /:id` (publish/unpublish) · `DELETE /:id` (refuses while published) |
| Contact inbox | `GET /contact-submissions` (paginated; filter by status, topic, date, free text; `newCount` for the badge) · `GET /:id` · `PATCH /:id` (status + internal note) · `DELETE /:id` |

Marking a submission anything other than `NEW` records who did it and when, so
"did anyone get back to this person" has an answer that doesn't depend on
somebody remembering. Moving it back to `NEW` clears that.

---

## Open questions for you

1. **`/terms` and `/privacy` behind an endpoint.** Not built — you flagged it as
   worth deciding together and the handoff copy is marked final, so building it
   speculatively seemed like the wrong call. Worth noting the shape you have
   ready (`title`, `updated`, `intro`, `sections: [{h, p}]`) is close to what
   we'd build, and the consent versioning above is the piece that would need to
   line up with it. Happy to do it as soon as it's a yes.
2. **Team portraits vs the About Us staff list.** `/public/content` already
   returns a `staff` array (name, position, bio, photo, LinkedIn) from a table
   the console manages, and `teamPortraits` is now a second list of four names
   that has to be kept in step with it by hand. They will drift. The clean
   version is `/about` reading the team from `staff` and portraits keyed to
   those rows — but that's your page's structure, not ours to change
   unilaterally. Flagging it rather than doing it.
3. **Testimonial copy.** Only the five portrait *names* live in the backend; the
   quotes themselves are still frontend copy. If those should be editable too,
   that's a small addition to the same table.
4. **Anything you want in the payloads that isn't there** — alt text, role
   slugs, a portrait id — all cheap now, and cheaper now than after you've typed
   against these shapes.

---

## Running it locally

```bash
pnpm db:push      # adds MarketingAsset, MarketingFaq, CareerRole,
                  # AppStoreLink, LegalConsent, ContactSubmission
pnpm db:seed      # empty image slots, seven FAQs, two roles, consent v2026-08-02
pnpm dev
```

The seed leaves every image slot empty on purpose, so a fresh checkout shows
your placeholders rather than broken images, and seeds no store links, so the
badge row is correctly absent. Postman folder `46. Marketing Site` covers all
seven public endpoints and the admin CRUD, including the empty and error states.
