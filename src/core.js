// Pure business rules: no database, no I/O. Everything here is unit-tested.
const crypto = require('node:crypto');

const TZ = 'Australia/Sydney';

// ---------- Dates (YYYY-MM-DD strings, Sydney calendar) ----------
function todaySyd(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function nowSydLabel(d = new Date()) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
function parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
function addMonths(s, n) {
  const d = parse(s); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); return iso(d);
}
// Whole months needed to cover start → end (rounded up), e.g. 15 Oct → 20 Jan = 4.
function monthsCovering(start, end) {
  let n = 0;
  while (addMonths(start, n) < end && n < 600) n++;
  return n;
}
function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
function monthStart(s) { return s.slice(0, 7) + '-01'; }
function fmtDate(s) {
  if (!s) return '';
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(parse(s.slice(0, 10)));
}
function fmtDateTime(isoStr) {
  if (!isoStr) return '';
  return new Intl.DateTimeFormat('en-AU', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(isoStr));
}

// ---------- Money / GST ----------
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// Prices are GST-inclusive (consumer pricing in Australia). GST component = 1/11 of the total.
const gstOf = (inc) => round2(inc / 11);
const aud = (n) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(Number(n) || 0);

// ---------- Pricing ----------
const TERM_MONTHS = { annual: 12, monthly: 3 }; // monthly = 3-month minimum commitment
const ftToM = (ft) => round2(ft * 0.3048);
const mToFt = (m) => round2(m / 0.3048);

function findRate(rates, lengthM, pkg, term) {
  return rates
    .filter((r) => r.package === pkg && r.term === term && lengthM > r.min_len && lengthM <= r.max_len)
    .sort((a, b) => a.max_len - b.max_len)[0];
}

function quote(rates, { lengthM, pkg, term, months }, opts = {}) {
  lengthM = Number(lengthM);
  if (!(lengthM > 0)) throw new Error('Enter your boat length.');
  if (!['standard', 'unlimited'].includes(pkg)) throw new Error('Choose a launch package.');
  if (!['annual', 'monthly'].includes(term)) throw new Error('Choose a contract term.');
  const minMonths = TERM_MONTHS[term];
  const m = Math.max(minMonths, Number(months) || minMonths); // annual: 12+ months, monthly: 3+ months
  if (term === 'monthly' && Number(months) && Number(months) < minMonths) throw new Error('Monthly storage has a 3-month minimum.');
  const rate = findRate(rates, lengthM, pkg, term);
  if (!rate) throw new Error('We need to quote this length individually. Send an enquiry and we will get back to you.');
  const deposit = opts.depositType === 'percent'
    ? round2(rate.monthly_rate * (Number(opts.depositValue) / 100))
    : round2(Number(opts.depositValue ?? 0));
  return {
    lengthM, lengthFt: mToFt(lengthM), pkg, term, months: m, minMonths,
    monthly: rate.monthly_rate, band: `${rate.min_len}–${rate.max_len} m`, placeholder: !!rate.placeholder,
    gstMonthly: gstOf(rate.monthly_rate), contractValue: round2(rate.monthly_rate * m), deposit,
  };
}

// ---------- Lift quota ----------
const INCLUDED_LIFTS = { standard: 2, unlimited: Infinity };
const EXTRA_LIFT_FEE = 30;
function isExtraLift(pkg, liftsAlreadyThisMonth) {
  return liftsAlreadyThisMonth >= (INCLUDED_LIFTS[pkg] ?? 0);
}

// ---------- Invoices ----------
// Storage is billed monthly in advance for `period` (YYYY-MM); extras dated before the period start are billed in arrears.
function buildInvoice({ booking, period, extras }) {
  const lines = [];
  if (booking && booking.monthly_rate) {
    lines.push({
      description: `Dry boat storage – ${period} (${booking.package} package, ${booking.term} term) – billed in advance`,
      category: 'storage', billing: 'advance', qty: 1, unit_inc: booking.monthly_rate, amount_inc: round2(booking.monthly_rate),
    });
  }
  const periodStart = `${period}-01`;
  for (const e of extras || []) {
    if (e.invoice_id || e.date >= periodStart) continue;
    lines.push({ description: `${e.description} (${e.date}) – billed in arrears`, category: e.category || 'extra', billing: 'arrears',
      qty: 1, unit_inc: e.amount_inc, amount_inc: round2(e.amount_inc), extra_id: e.id });
  }
  for (const l of lines) l.gst = gstOf(l.amount_inc);
  const total = round2(lines.reduce((s, l) => s + l.amount_inc, 0));
  const gst = round2(lines.reduce((s, l) => s + l.gst, 0));
  return { lines, total, gst, subtotal_ex: round2(total - gst) };
}

// ---------- Watchlist ----------
const normEmail = (s) => (s || '').trim().toLowerCase();
const normPhone = (s) => { let d = (s || '').replace(/\D/g, ''); if (d.startsWith('61')) d = '0' + d.slice(2); return d; };
const normId = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normName = (s) => (s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
const sim = (a, b) => (a && b ? 1 - levenshtein(a, b) / Math.max(a.length, b.length) : 0);
const plainName = (s) => (s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).join(' ');
// Best of as-typed order and sorted-token order, so "Kris Fakename" and "Fakename, Chris" both match "Chris Fakename".
function nameSimilarity(a, b) {
  return Math.max(sim(plainName(a), plainName(b)), sim(normName(a), normName(b)));
}
// Fuzzy on name, exact (normalised) on email / phone / rego / HIN.
function matchWatchlist(entries, subject, threshold = 0.82) {
  const out = [];
  for (const w of entries) {
    const reasons = [];
    if (w.email && normEmail(w.email) === normEmail(subject.email)) reasons.push('email');
    if (w.phone && normPhone(subject.phone) && normPhone(w.phone) === normPhone(subject.phone)) reasons.push('phone');
    if (w.rego && normId(subject.rego) && normId(w.rego) === normId(subject.rego)) reasons.push('rego');
    if (w.hin && normId(subject.hin) && normId(w.hin) === normId(subject.hin)) reasons.push('HIN');
    const sim = w.name && subject.name ? nameSimilarity(w.name, subject.name) : 0;
    if (sim >= threshold) reasons.push(`name ${Math.round(sim * 100)}%`);
    if (reasons.length) out.push({ watch: w, reasons });
  }
  return out;
}

// ---------- Stripe webhook signature (no SDK needed) ----------
function verifyStripeSignature(payload, header, secret, toleranceSec = 300, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, v]));
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

// ---------- Passwords & sessions ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
function sign(value, secret) {
  return `${value}.${crypto.createHmac('sha256', secret).update(value).digest('base64url')}`;
}
function unsign(signed, secret) {
  if (!signed) return null;
  const i = signed.lastIndexOf('.');
  const value = signed.slice(0, i);
  const expected = sign(value, secret);
  if (expected.length !== signed.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signed))) return null;
  return value;
}

const render = (tpl, vars) => (tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? ''));

module.exports = {
  TZ, todaySyd, nowSydLabel, addDays, addMonths, monthsCovering, daysBetween, monthStart, fmtDate, fmtDateTime,
  round2, gstOf, aud, TERM_MONTHS, ftToM, mToFt, findRate, quote,
  INCLUDED_LIFTS, EXTRA_LIFT_FEE, isExtraLift, buildInvoice,
  normPhone, normId, nameSimilarity, matchWatchlist, verifyStripeSignature,
  hashPassword, verifyPassword, sign, unsign, render,
};
