# Plan, decisions & status

## Stack (and why)
- **Node 24 + Express 5 + EJS, server-rendered.** A single codebase serves the website (SEO-friendly HTML), the admin and the portal. No build step.
- **SQLite via built-in `node:sqlite`.** No database server and nothing native to compile. **Double bookings are blocked in the database**: `BEFORE INSERT/UPDATE` triggers on `bookings` abort any overlapping active allocation (hold, pending, confirmed, active, maintenance) for the same bay. Expired holds are ignored by the trigger. Writes are serialised (`BEGIN IMMEDIATE`).
  - *Scale-up path:* move to Postgres and swap the triggers for `EXCLUDE USING gist (bay_id WITH =, daterange(start_date,end_date) WITH &&) WHERE (status IN (...))`. The SQL is portable.
- **Stripe without the SDK:** Checkout Sessions via REST plus manual webhook signature verification (`core.verifyStripeSignature`). Without keys, a demo checkout runs the same confirmation code.
- **Email/SMS:** everything goes to an `outbox` table with dedupe keys. A provider can drain it later (`services.providers`).
- **Uploads:** local `uploads/` via multer, signed-in users only. Swap for S3/R2 in production.

## Data model (main tables)
`customers`, `boats` (QR token), `bays`, `rates` (length band × package × term), `leads` (pipeline stage, source, quote JSON), `bookings` (storage or maintenance block; hold/pending/confirmed/active…), `contracts` (T&C version and acceptance time), `invoices` + `invoice_lines` (advance/arrears, GST per line), `payments` (method, reference, reconciled), `extras` (extra lifts and services, billed in arrears), `lifts`, `checklist_templates`, `checklists` (results, inventory, fuel, photos, signature, released_to, link from return to release), `service_jobs`, `assets` + `maintenance_jobs` (recurring), `expenses`, `watchlist` + `watch_alerts`, `communications`, `email_templates`, `outbox`, `audit_log`, `settings`. Phase 2 hooks: `integrations`, `devices` (GPS/fuel/RFID).

## Milestone status
| # | Milestone | Status |
|---|---|---|
| 1 | Public website, nav/footer, weather (Open-Meteo, cached 10 min), GA4 + consent, SEO (titles, OG, sitemap, robots, LocalBusiness JSON-LD) | Done. Copy is placeholder (no `/content` supplied). Logo and colours taken from the client's current site. |
| 2 | Quote, enquiry, booking, 30-min hold, Stripe/demo + manual payment, pending expiry and reminders, confirmation email, PDF summary (print), spam protection | Done |
| 3 | Bays, timeline calendar, move/extend/cancel with audited reason, DB-level no-double-booking, availability dashboard (30/60/90) | Done |
| 4 | CRM (customers with full history), boats, info sheet with QR, lead pipeline with lost reason | Done |
| 5 | Check-in/release/return checklists, editable templates, photos, signature, release log, release-vs-return diff, PDF (print), email | Done |
| 6 | Lift slots (hours/slot/capacity/blackouts), quota and $30 extras, engine flush rule, service jobs → invoice | Done |
| 7 | Facility maintenance, recurring jobs, bay blocks on calendar, due/overdue on dashboard and digest | Done |
| 8 | Contracts, monthly invoice run (advance + arrears, GST, ABN), payments + reconciliation, expenses with receipts, P&L month/quarter/YTD, aging, sales dashboard, CSV exports | Done |
| 9 | Templates, scheduled jobs (holds every minute, the rest every 15 min, plus "Run now"), renewal 60/30, insurance, lift reminders, daily digest | Done |
| 10 | Watchlist: fuzzy name, exact email/phone/rego/HIN, staff alerts only, admin-only, audited views | Done |
| 11 | CSV import with dry run (bays, customers, boats, bookings, balances) | Done |

## Known gaps / next
- 2FA for staff (TOTP) is modelled (`users.totp_enabled`) but not built.
- PDFs use the browser's print-to-PDF; add server-side PDF attachments to emails when a mail provider is connected.
- No CSRF tokens yet (SameSite=Lax cookies mitigate this). Add before going live.
- Lighthouse not yet run; target ≥ 90 on mobile.
- Stock photos are from Unsplash (free licence). Replace them with the client's own photos.

## Open questions for the client (seeded as placeholders, flagged in Settings)
1. Full rate table (only "from $547/month" is confirmed). 2. Bay count, sizes and zones (seeded 24 bays in 3 zones). 3. Reservation fee (seeded $250 fixed) and the refund/cancellation policy. 4. Lift hours, slot length and capacity (seeded 07:00–16:00, 60 min, 2 per slot). 5. Legal name, ABN, bank details, phone. 6. Page copy for every page.
