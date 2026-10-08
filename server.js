const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { open, helpers } = require('./src/db');
const C = require('./src/core');
const S = require('./src/services');

// On Vercel the deployment is read-only; only /tmp is writable (and resets between cold starts).
const ON_VERCEL = !!process.env.VERCEL;
const RUNTIME_DIR = ON_VERCEL ? '/tmp' : __dirname;
const DB_FILE = process.env.DB_FILE || path.join(RUNTIME_DIR, 'data', 'cockatoo.db');
process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(RUNTIME_DIR, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });
const h = fs.existsSync(DB_FILE) ? helpers(open(DB_FILE)) : require('./src/seed').seed(DB_FILE);
const SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';

const app = express();
app.set('view engine', 'ejs');
app.locals.assetV = Date.now().toString(36);
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Stripe webhook needs the raw body for signature verification.
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(express.json({ limit: '8mb' }));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));


// Session cookie → req.user
app.use((req, res, next) => {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((c) => c[0]));
  const v = C.unsign(decodeURIComponent(cookies.cm_sess || ''), SECRET);
  if (v) {
    const [id, exp] = v.split(':');
    if (Number(exp) > Date.now()) req.user = h.get('SELECT id,email,name,role,customer_id FROM users WHERE id=?', Number(id));
  }
  req.cookies = cookies;
  res.locals.user = req.user;
  res.locals.C = C;
  res.locals.h = h;
  res.locals.path = req.path;
  res.locals.ga4 = process.env.GA4_ID || '';
  res.locals.flash = cookies.cm_flash ? decodeURIComponent(cookies.cm_flash) : '';
  if (cookies.cm_flash) res.append('Set-Cookie', 'cm_flash=; Max-Age=0; Path=/');
  res.locals.biz = { name: h.setting('business_name'), phone: h.setting('phone'), address: h.setting('address'), abn: h.setting('abn') };
  next();
});
app.use('/uploads', (req, res, next) => (req.user ? next() : res.status(403).end()), express.static(process.env.UPLOAD_DIR));
app.locals.login = (res, user) => {
  const val = C.sign(`${user.id}:${Date.now() + 12 * 3600e3}`, SECRET);
  res.append('Set-Cookie', `cm_sess=${encodeURIComponent(val)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
};
app.locals.flash = (res, msg) => res.append('Set-Cookie', `cm_flash=${encodeURIComponent(msg)}; Path=/; Max-Age=30`);
app.locals.SECRET = SECRET;

app.use(require('./src/routes/public')(h, app));
app.use(require('./src/routes/portal')(h, app));
app.use('/admin', require('./src/routes/admin')(h, app));

app.use((req, res) => res.status(404).render('public/message', { title: 'Page not found', heading: 'We couldn’t find that page', body: 'Check the address, or head back to the home page.', meta: {} }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).render('public/message', { title: 'Something went wrong', heading: 'Something went wrong', body: err.expose ? err.message : 'The error has been logged. Try again, or call the office.', meta: {} });
});

// Scheduled jobs: holds every minute, everything else every 15 minutes (idempotent via outbox dedupe keys).
setInterval(() => S.expireHolds(h), 60e3).unref();
setInterval(() => { try { S.runScheduledJobs(h); } catch (e) { console.error('jobs', e); } }, 15 * 60e3).unref();

module.exports = app; // Vercel imports the app; locally we listen on a port.
if (!ON_VERCEL) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Cockatoo Marine running on http://localhost:${port}`));
}
