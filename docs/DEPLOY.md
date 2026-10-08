# Deploying

The app is one Node process plus a SQLite file and an uploads folder, so any host with a persistent disk works.

**Recommended: Fly.io or Render (~US$5–10/month)**
1. Create the app with a persistent volume mounted at `/data`.
2. Set env vars: `NODE_ENV=production`, `BASE_URL=https://your-domain`, `SESSION_SECRET` (long random), `DB_FILE=/data/cockatoo.db`, and optionally `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `GA4_ID`.
3. Point `uploads/` at the volume (symlink `uploads -> /data/uploads`) or move uploads to S3/R2.
4. Start command: `npm start`. Run `npm run seed` once only for a demo. For production, import real data via Admin › Import instead.
5. Stripe: add a webhook endpoint `https://your-domain/webhooks/stripe` for `checkout.session.completed`.
6. Backups: copy the SQLite file nightly (for example with `sqlite3 .backup` or Litestream to S3).

A plain VPS (Lightsail or a DigitalOcean droplet) with `pm2` and Caddy for HTTPS works the same way.
