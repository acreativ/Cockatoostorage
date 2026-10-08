const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { connect } = require('./src/db');
const { serveFile } = require('./src/files');
const C = require('./src/core');
const S = require('./src/services');

// Postgres (Supabase) via DATABASE_URL. Works the same locally (`npm start`) and on Vercel (exported app).
const h = connect();


const app = express();
app.set('view engine', 'ejs');
app.locals.assetV = Date.now().toString(36);
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Session cookies are signed with SESSION_SECRET, or failing that a random secret generated once and kept in the database,
// so every server instance signs and checks cookies with the same key.
let SECRET = process.env.SESSION_SECRET || '';
let readyP;
const ensureReady = () => (readyP ??= (async () => {
  if (!SECRET) {
    await h.run(`INSERT INTO app_state (key, value) VALUES ('session_secret', ?) ON CONFLICT (key) DO NOTHING`, crypto.randomBytes(32).toString('hex'));
    SECRET = (await h.get(`SELECT value FROM app_state WHERE key='session_secret'`)).value;
  }
  app.locals.SECRET = SECRET;
})().catch((e) => { readyP = null; throw e; })); // retry on the next request if the database was unreachable

// Stripe webhook needs the raw body for signature verification.
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));
app.use(express.json({ limit: '4mb' }));
// On Vercel, files in public/ are served by the CDN (vercel.json maps /static/* to them); this serves them locally.
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

// Scheduled jobs. There is no always-on process on Vercel, so they run on incoming requests:
// expire lapsed holds at most once a minute, and the reminder/overdue/digest jobs at most every 15 minutes.
// A compare-and-set in the database makes sure only one instance runs them; the jobs themselves are idempotent.
async function claimJob(key, everyMs) {
  const now = Date.now();
  const r = await h.run(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    WHERE CAST(app_state.value AS bigint) < ? RETURNING key`, key, String(now), now - everyMs);
  return r.changes > 0;
}
let lastCheck = 0;
async function runDueJobs() {
  if (Date.now() - lastCheck < 60e3) return; // this instance checked recently
  lastCheck = Date.now();
  if (await claimJob('jobs_holds_at', 60e3)) await S.expireHolds(h);
  if (await claimJob('jobs_all_at', 15 * 60e3)) {
    try { await S.runScheduledJobs(h); } catch (e) { console.error('jobs', e); }
  }
}

// Per request: wait for startup, load settings, run due jobs, then read the session cookie → req.user.
app.use(async (req, res, next) => {
  await ensureReady();
  await h.loadSettings();
  if (!req.path.startsWith('/static')) await runDueJobs().catch((e) => console.error('jobs', e));
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((c) => c[0]));
  const v = C.unsign(decodeURIComponent(cookies.cm_sess || ''), SECRET);
  if (v) {
    const [id, exp] = v.split(':');
    if (Number(exp) > Date.now()) req.user = await h.get('SELECT id,email,name,role,customer_id FROM users WHERE id=?', Number(id));
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
app.get('/uploads/:name', serveFile(h));
app.locals.login = (res, user) => {
  const val = C.sign(`${user.id}:${Date.now() + 12 * 3600e3}`, SECRET);
  res.append('Set-Cookie', `cm_sess=${encodeURIComponent(val)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
};
app.locals.flash = (res, msg) => res.append('Set-Cookie', `cm_flash=${encodeURIComponent(msg)}; Path=/; Max-Age=30`);

app.use(require('./src/routes/public')(h, app));
app.use(require('./src/routes/portal')(h, app));
app.use('/admin', require('./src/routes/admin')(h, app));

app.use((req, res) => res.status(404).render('public/message', { title: 'Page not found', heading: 'We couldn’t find that page', body: 'Check the address, or head back to the home page.', meta: {} }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).render('public/message', { title: 'Something went wrong', heading: 'Something went wrong', body: err.expose ? err.message : 'The error has been logged. Try again, or call the office.', meta: {} });
});

module.exports = app;

// Local: `npm start`. On Vercel the exported app is used and this block does not run.
if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Cockatoo Marine running on http://localhost:${port}`));
}
