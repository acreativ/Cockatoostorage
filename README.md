# Cockatoo Marine: website + storage booking & operations

One Node app serving the public website, the online quote/booking flow, the staff admin and the customer portal.

## Run it

```bash
npm install
npm run seed     # creates data/cockatoo.db with demo data (re-run any time to reset)
npm start        # http://localhost:3000
npm test         # 18 unit + database tests
```

Requires Node 22.13+ (uses the built-in `node:sqlite`, so there is no database server to install).

Demo logins (password `demo1234`): `admin@cockatoo.test`, `office@cockatoo.test`, `yard@cockatoo.test`, `finance@cockatoo.test`, customer `sam.taylor@example.com`. The login page has one-click buttons for each.

## Where things are

| Area | URL |
|---|---|
| Website, weather, quote widget | `/` |
| Quote → book → pay deposit | `/book` |
| Staff admin | `/admin` (dashboard, calendar, bookings, leads, customers, boats, checklists, release log, lifts, service jobs, maintenance, bays, invoices, expenses, reports, watchlist, import, settings, outbox, audit) |
| Customer portal | `/portal` |
| Emails sent | `/admin/outbox` (nothing leaves the server until an email provider is connected) |

Code: `src/core.js` (pure rules: pricing, GST, lift quota, invoices, watchlist matching, Stripe signatures), `src/services.js` (bookings, payments, invoicing, lifts, scheduled jobs), `src/db.js` (schema and double-booking triggers), `src/routes/*` (pages), `views/` (EJS), `public/` (CSS/JS/images).

Extra checks: `node scripts/smoke.mjs` crawls every page per role; `node scripts/flows.mjs` runs the main POST flows (point both at a server running on a throwaway `DB_FILE`).
