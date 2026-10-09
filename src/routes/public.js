const express = require('express');
const crypto = require('node:crypto');
const C = require('../core');
const S = require('../services');
const CMS = require('../cms');

// ---------- Weather (Open-Meteo, keyless, cached 10 min) ----------
let wxCache = { at: 0, data: null };
async function weather() {
  if (wxCache.data && Date.now() - wxCache.at < 600e3) return wxCache.data;
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=-33.847&longitude=151.171'
    + '&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_direction_10m_dominant'
    + '&timezone=Australia%2FSydney&forecast_days=4&wind_speed_unit=kn';
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error(r.status);
    wxCache = { at: Date.now(), data: await r.json() };
  } catch { /* keep stale data, or none */ }
  return wxCache.data;
}

// ---------- Spam protection: honeypot + per-IP rate limit ----------
const hits = new Map();
function guard(req, res, next) {
  if (req.body?.website) return res.status(400).render('public/message', { title: 'Not sent', heading: 'Your message was not sent', body: 'Please try again.', meta: {} });
  const key = req.ip, now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 10 * 60e3);
  list.push(now); hits.set(key, list);
  if (list.length > 20) return res.status(429).render('public/message', { title: 'Too many requests', heading: 'Too many requests', body: 'Please wait a few minutes and try again, or call the office.', meta: {} });
  next();
}

const clean = (s, max = 500) => (s == null ? '' : String(s).trim().slice(0, max));
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

module.exports = (h, app) => {
  const r = express.Router();
  const meta = (title, description, path) => ({ title, description, path });

  weather(); // warm the cache at boot so the first visitor doesn't wait
  r.get('/', (req, res) => {
    const wx = wxCache.data; // never block the page on the weather API
    if (!wx || Date.now() - wxCache.at > 600e3) weather();
    const minRate = h.get('SELECT MIN(monthly_rate) m FROM rates').m;
    res.render('public/home', { meta: meta('Dry Boat Storage Sydney from $547/month | Cockatoo Marine',
      'Affordable dry boat storage on Cockatoo Island, Sydney. Standard and Unlimited launch packages, annual or monthly terms. Get an instant quote and book online.', '/'), wx, minRate, content: CMS.home(h) });
  });

  r.get('/api/weather', async (req, res) => res.json(await weather() || { error: 'unavailable' }));
  r.get('/partials/weather', async (req, res) => res.render('partials/weather', { wx: await weather() }));

  // All four package/term options for a boat in one call (powers the single-page booking flow).
  r.get('/api/options', (req, res) => {
    const lengthM = req.query.unit === 'ft' ? C.ftToM(Number(req.query.length)) : Number(req.query.length);
    if (!(lengthM > 0 && lengthM <= 30)) return res.status(400).json({ error: 'Enter a boat length between 1 and 30 metres.' });
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '') && req.query.start >= C.todaySyd() ? req.query.start : C.addDays(C.todaySyd(), 7);
    // Requested stay: end date (at least 3 months after start). Annual contracts are never shorter than 12 months.
    const minEnd = C.addMonths(start, 3);
    const end = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end || '') && req.query.end >= minEnd ? req.query.end : C.addMonths(start, 12);
    const stay = C.monthsCovering(start, end);
    const options = [];
    for (const pkg of ['standard', 'unlimited']) for (const term of ['annual', 'monthly']) {
      try {
        const q = S.getQuote(h, { lengthM, pkg, term, months: stay });
        const bEnd = S.stayEnd(start, term, end);
        options.push({ ...q, end: bEnd, endLabel: C.fmtDate(bEnd), extendsStay: bEnd > end, available: S.availableBays(h, lengthM, start, bEnd).length });
      } catch (e) { return res.json({ lengthM, start, end, error: e.message, options: [] }); }
    }
    res.json({ lengthM, lengthFt: C.mToFt(lengthM), start, startLabel: C.fmtDate(start), end, endLabel: C.fmtDate(end), minEnd, stayMonths: stay, options });
  });

  // ----- Quote & booking flow -----
  r.get('/api/quote', (req, res) => {
    try {
      const lengthM = req.query.unit === 'ft' ? C.ftToM(Number(req.query.length)) : Number(req.query.length);
      const q = S.getQuote(h, { lengthM, pkg: req.query.pkg, term: req.query.term, months: req.query.months });
      const start = req.query.start || C.addDays(C.todaySyd(), 7);
      const bays = S.availableBays(h, lengthM, start, S.bookingEnd(start, q.term, q.months));
      res.json({ ...q, available: bays.length, start });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.get(['/book', '/dry-boat-storage/quote'], (req, res) => {
    const q = req.query;
    const unit = q.unit === 'ft' ? 'ft' : 'm';
    const lengthM = q.length ? (unit === 'ft' ? C.ftToM(Number(q.length)) : Number(q.length)) : null;
    const start = q.start && q.start >= C.todaySyd() ? q.start : C.addDays(C.todaySyd(), 7);
    let step = 1, options = null, error = null, chosen = null;
    if (lengthM) {
      if (!(lengthM > 0 && lengthM <= 30)) error = 'Enter a boat length between 1 and 30 metres.';
      else {
        step = 2;
        options = [];
        for (const pkg of ['standard', 'unlimited']) for (const term of ['annual', 'monthly']) {
          try {
            const qq = S.getQuote(h, { lengthM, pkg, term });
            const avail = S.availableBays(h, lengthM, start, S.bookingEnd(start, term)).length;
            options.push({ ...qq, available: avail });
          } catch (e) { error = e.message; }
        }
        if (q.pkg && q.term) {
          chosen = options.find((o) => o.pkg === q.pkg && o.term === q.term);
          if (chosen) step = 3;
        }
      }
    }
    res.render('public/book', { meta: meta('Get a dry boat storage quote | Cockatoo Marine', 'Instant price and live availability for dry boat storage on Cockatoo Island.', '/book'),
      q, unit, lengthM, start, step, options, chosen, error, holdMinutes: h.setting('hold_minutes', 30), pendingDays: h.setting('pending_days', 3) });
  });

  r.post('/book', guard, (req, res) => {
    const b = req.body;
    const back = (msg) => res.status(400).render('public/message', { title: 'Check your details', heading: 'Check your details', body: msg, meta: {}, back: true });
    const name = clean(b.name, 120), email = clean(b.email, 200).toLowerCase(), phone = clean(b.phone, 40);
    if (!name || !validEmail(email) || phone.replace(/\D/g, '').length < 8) return back('Enter your name, a valid email and a phone number.');
    const lengthM = Number(b.lengthM);
    let qq;
    try { qq = S.getQuote(h, { lengthM, pkg: b.pkg, term: b.term, months: b.months }); } catch (e) { return back(e.message); }
    const start = clean(b.start, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || start < C.todaySyd()) return back('Choose a start date from today onwards.');
    const end = clean(b.end, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || end < C.addMonths(start, 3)) return back('Choose an end date at least 3 months after the start date.');
    try { qq = S.getQuote(h, { lengthM, pkg: b.pkg, term: b.term, months: C.monthsCovering(start, end) }); } catch (e) { return back(e.message); }
    const action = b.action; // enquire | card | bank
    const quoteInfo = { ...qq, start, end: S.stayEnd(start, qq.term, end), boat: { type: clean(b.type, 60), make_model: clean(b.make_model, 120), trailer: b.trailer === 'yes', rego: clean(b.rego, 20), hin: clean(b.hin, 30) } };
    const cust = S.upsertCustomer(h, { name, email, phone, source: 'website' });

    if (action === 'enquire') {
      S.createLead(h, { customer_id: cust.id, name, email, phone, service: 'storage', source: 'website', stage: 'quoted', message: clean(b.message, 2000), quote: quoteInfo });
      return res.render('public/thanks', { meta: meta('Enquiry sent | Cockatoo Marine', '', '/book'), kind: 'enquiry', name, event: 'enquiry_submitted' });
    }
    if (b.terms !== 'yes') return back('Please accept the storage terms and conditions to book.');

    let booking;
    try {
      booking = h.tx(() => {
        const boat = h.run(`INSERT INTO boats (customer_id,name,type,make_model,length_m,rego,hin,trailer,qr_token) VALUES (?,?,?,?,?,?,?,?,?)`,
          cust.id, clean(b.boat_name, 60) || quoteInfo.boat.make_model || 'Boat', quoteInfo.boat.type, quoteInfo.boat.make_model, lengthM,
          quoteInfo.boat.rego || null, quoteInfo.boat.hin || null, quoteInfo.boat.trailer ? 1 : 0, crypto.randomBytes(12).toString('base64url'));
        const leadId = S.createLead(h, { customer_id: cust.id, name, email, phone, service: 'storage', source: 'website', stage: 'deposit_pending', quote: quoteInfo, message: clean(b.message, 2000) });
        const isCard = action === 'card';
        const bk = S.createBooking(h, {
          lengthM, customer_id: cust.id, boat_id: Number(boat.lastInsertRowid), lead_id: leadId, package: qq.pkg, term: qq.term, monthly_rate: qq.monthly,
          start_date: start, end_date: S.stayEnd(start, qq.term, end), deposit_amount: qq.deposit,
          status: isCard ? 'hold' : 'pending',
          hold_expires_at: isCard ? new Date(Date.now() + Number(h.setting('hold_minutes', 30)) * 60e3).toISOString() : null,
          pending_expires_at: isCard ? null : new Date(Date.now() + Number(h.setting('pending_days', 3)) * 86400e3).toISOString(),
          notes: `T&Cs ${h.setting('tc_version')} accepted online ${new Date().toISOString()}`,
        }, null);
        S.screenWatchlist(h, 'booking', bk.id, { name, email, phone, rego: quoteInfo.boat.rego, hin: quoteInfo.boat.hin });
        return bk;
      });
    } catch (e) { return back(e.message); }

    if (action === 'card') return res.redirect(`/checkout/${booking.ref}`);
    S.notify(h, { to: email, template: 'booking_pending', customerId: cust.id, vars: { name, ref: booking.ref, amount: C.aud(booking.deposit_amount),
      expires: C.fmtDateTime(booking.pending_expires_at), bank: h.setting('bank_details') } });
    res.redirect(`/booking/${booking.ref}?new=1`);
  });

  r.get('/booking/:ref', (req, res) => {
    const b = h.get(`SELECT b.*, bay.code bay_code, bay.zone, c.name cname, c.email, bt.make_model, bt.length_m FROM bookings b JOIN bays bay ON bay.id=b.bay_id
      LEFT JOIN customers c ON c.id=b.customer_id LEFT JOIN boats bt ON bt.id=b.boat_id WHERE b.ref=?`, req.params.ref);
    if (!b || b.kind !== 'storage') return res.status(404).render('public/message', { title: 'Not found', heading: 'Booking not found', body: 'Check the reference in your email.', meta: {} });
    res.render('public/booking', { meta: meta(`Booking ${b.ref} | Cockatoo Marine`, '', ''), b, bank: h.setting('bank_details'), isNew: !!req.query.new, paid: !!req.query.paid });
  });

  // ----- Payments -----
  r.get('/checkout/:ref', async (req, res, next) => {
    const b = h.get(`SELECT b.*, c.email FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE ref=?`, req.params.ref);
    if (!b) return next();
    if (b.deposit_paid) return res.redirect(`/booking/${b.ref}`);
    if (b.status !== 'hold' || b.hold_expires_at <= new Date().toISOString())
      return res.render('public/message', { title: 'Hold expired', heading: 'Your hold has expired', body: 'The bay was released after 30 minutes. Start a new quote and we will check availability again.', meta: {}, cta: { href: '/book', label: 'Start a new quote' } });
    const key = process.env.STRIPE_SECRET_KEY;
    if (key) {
      const base = h.setting('base_url');
      const form = new URLSearchParams({
        mode: 'payment', customer_email: b.email, client_reference_id: b.ref,
        'line_items[0][price_data][currency]': 'aud', 'line_items[0][price_data][unit_amount]': String(Math.round(b.deposit_amount * 100)),
        'line_items[0][price_data][product_data][name]': `Reservation fee – booking ${b.ref}`, 'line_items[0][quantity]': '1',
        success_url: `${base}/booking/${b.ref}?paid=1`, cancel_url: `${base}/checkout/${b.ref}`, 'metadata[booking_ref]': b.ref,
        expires_at: String(Math.floor(Date.now() / 1000) + 31 * 60),
      });
      const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
      const sess = await resp.json();
      if (!resp.ok) return next(Object.assign(new Error(sess.error?.message || 'Stripe error'), { expose: true }));
      h.run('UPDATE bookings SET stripe_session_id=? WHERE id=?', sess.id, b.id);
      return res.redirect(303, sess.url);
    }
    res.render('public/checkout', { meta: meta('Pay deposit | Cockatoo Marine', '', ''), b });
  });

  // Demo-mode payment (only when Stripe isn't configured) runs the same confirmation path as the webhook.
  r.post('/checkout/:ref/demo-pay', (req, res, next) => {
    if (process.env.STRIPE_SECRET_KEY) return next();
    const b = h.get('SELECT * FROM bookings WHERE ref=?', req.params.ref);
    if (!b) return next();
    try { S.confirmBooking(h, b.id, { amount: b.deposit_amount, method: 'stripe', reference: 'demo_' + crypto.randomBytes(4).toString('hex') }, null); }
    catch (e) { return res.render('public/message', { title: 'Payment not applied', heading: 'We could not confirm this booking', body: e.message, meta: {} }); }
    res.redirect(`/booking/${b.ref}?paid=1`);
  });

  r.post('/webhooks/stripe', (req, res) => {
    const payload = req.body.toString('utf8');
    if (!C.verifyStripeSignature(payload, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET)) return res.status(400).send('bad signature');
    res.json(handleStripeEvent(h, JSON.parse(payload)));
  });

  // ----- Enquiries for all services -----
  r.post('/enquiry', guard, (req, res) => {
    const b = req.body;
    const name = clean(b.name, 120), email = clean(b.email, 200).toLowerCase(), phone = clean(b.phone, 40);
    const service = ['storage', 'antifoul', 'marina', 'commercial', 'barging', 'events', 'other'].includes(b.service) ? b.service : 'other';
    if (!name || (!validEmail(email) && phone.length < 8)) return res.status(400).render('public/message', { title: 'Check your details', heading: 'Check your details', body: 'Enter your name and an email or phone number so we can reply.', meta: {}, back: true });
    const cust = validEmail(email) ? S.upsertCustomer(h, { name, email, phone, source: 'website' }) : null;
    S.createLead(h, { customer_id: cust?.id, name, email, phone, service, source: 'website', message: clean(b.message, 3000) });
    res.render('public/thanks', { meta: meta('Enquiry sent | Cockatoo Marine', '', '/enquiry'), kind: 'enquiry', name, event: 'enquiry_submitted' });
  });

  // ----- QR scans: staff get the record, the public gets nothing personal -----
  r.get('/q/:token', (req, res) => {
    const boat = h.get('SELECT id FROM boats WHERE qr_token=?', req.params.token);
    if (boat && req.user && req.user.role !== 'customer') return res.redirect(`/admin/boats/${boat.id}?scan=1`);
    res.render('public/message', { title: 'Cockatoo Marine', heading: 'This boat is stored at Cockatoo Marine', body: 'Staff: sign in to open this boat’s record. Found this boat somewhere unexpected? Call the office.', meta: {},
      cta: { href: `/login?next=${encodeURIComponent(req.originalUrl)}`, label: 'Staff sign in' } });
  });

  // ----- SEO -----
  r.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /portal\nDisallow: /booking/\nDisallow: /checkout/\nDisallow: /q/\nSitemap: ${h.setting('base_url')}/sitemap.xml\n`));
  r.get('/sitemap.xml', (req, res) => {
    const urls = ['/', '/book', ...h.all(`SELECT slug FROM pages WHERE status='published'`).map((p) => '/' + p.slug)].map((p) => `<url><loc>${h.setting('base_url')}${p}</loc></url>`).join('');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
  });


  // ----- Auth -----
  r.get('/login', (req, res) => res.render('public/login', { meta: meta('Sign in | Cockatoo Marine', '', '/login'), next: req.query.next || '', error: null, sent: false }));
  r.post('/login', guard, (req, res) => {
    const u = h.get('SELECT * FROM users WHERE lower(email)=lower(?)', clean(req.body.email, 200));
    const nextUrl = /^\/[a-z]/i.test(req.body.next || '') ? req.body.next : null;
    if (req.body.magic) {
      if (u && u.role === 'customer') {
        const tok = C.sign(`${u.id}:${Date.now() + 30 * 60e3}`, app.locals.SECRET);
        S.notify(h, { to: u.email, template: 'magic_link', vars: { name: u.name, link: `${h.setting('base_url')}/magic?t=${encodeURIComponent(tok)}` } });
      }
      return res.render('public/login', { meta: meta('Sign in | Cockatoo Marine', '', '/login'), next: '', error: null, sent: true });
    }
    if (!u || !C.verifyPassword(req.body.password || '', u.password_hash))
      return res.status(401).render('public/login', { meta: meta('Sign in | Cockatoo Marine', '', '/login'), next: req.body.next, error: 'Email or password is incorrect.', sent: false });
    app.locals.login(res, u);
    S.audit(h, u, 'login', 'user', u.id);
    res.redirect(nextUrl || (u.role === 'customer' ? '/portal' : '/admin'));
  });
  r.get('/magic', (req, res) => {
    const v = C.unsign(String(req.query.t || ''), app.locals.SECRET);
    const [id, exp] = (v || '').split(':');
    if (!v || Number(exp) < Date.now()) return res.render('public/message', { title: 'Link expired', heading: 'This sign-in link has expired', body: 'Request a new link from the sign-in page.', meta: {}, cta: { href: '/login', label: 'Sign in' } });
    app.locals.login(res, { id: Number(id) });
    res.redirect('/portal');
  });
  r.post('/logout', (req, res) => { res.append('Set-Cookie', 'cm_sess=; Max-Age=0; Path=/'); res.redirect('/'); });

  // ----- CMS pages (edited in Admin › Website). Last, so fixed routes win. Staff can preview drafts. -----
  r.get('/:slug', (req, res, next) => {
    const page = h.get('SELECT * FROM pages WHERE slug=?', req.params.slug);
    const staff = req.user && req.user.role !== 'customer';
    if (!page || (page.status !== 'published' && !staff)) return next();
    res.render('public/page', { meta: meta(page.title || page.h1, page.description, page.status === 'published' ? '/' + page.slug : ''), page, path: '/' + page.slug, draft: page.status !== 'published' });
  });

  return r;
};

function handleStripeEvent(h, event) {
  if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
    const s = event.data.object;
    const ref = s.metadata?.booking_ref || s.client_reference_id;
    const b = h.get('SELECT * FROM bookings WHERE ref=?', ref);
    if (b) {
      try { S.confirmBooking(h, b.id, { amount: s.amount_total / 100, method: 'stripe', reference: s.payment_intent || s.id }, null); }
      catch (e) {
        // Paid after the hold lapsed and the bay was taken: record for a manual refund/re-allocation, never double-book.
        S.audit(h, null, 'payment_conflict', 'booking', b.id, { error: e.message, session: s.id });
        S.notify(h, { to: h.setting('staff_email'), subject: `Payment received but bay unavailable – ${b.ref}`, body: `Stripe session ${s.id}. Re-allocate or refund.` });
        return { received: true, conflict: true };
      }
    }
    if (s.metadata?.invoice_id) {
      const inv = h.get('SELECT * FROM invoices WHERE id=?', Number(s.metadata.invoice_id));
      if (inv && !h.get('SELECT 1 FROM payments WHERE reference=?', s.payment_intent || s.id))
        S.recordPayment(h, { invoice_id: inv.id, customer_id: inv.customer_id, amount: s.amount_total / 100, method: 'stripe', reference: s.payment_intent || s.id }, null);
    }
  }
  return { received: true };
}
module.exports.handleStripeEvent = handleStripeEvent;
