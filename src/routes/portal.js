// Customer portal: boats, contract, invoices (pay online), lift booking, checklists, boat info sheet.
const express = require('express');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const C = require('../core');
const S = require('../services');
const { html, raw, pill, table, field, money, d, dt, label } = require('../ui');
const { renderChecklist } = require('./admin-crm');
const { renderInvoice } = require('./admin-finance');

module.exports = (h, app) => {
  const r = express.Router();
  const NAV = [['/portal', 'Overview'], ['/portal/lifts', 'Book a lift'], ['/portal/invoices', 'Invoices'], ['/portal/checklists', 'Condition reports']];
  r.use('/portal', (req, res, next) => {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (req.user.role !== 'customer') return res.redirect('/admin');
    req.cid = req.user.customer_id;
    next();
  });
  const page = (req, res, title, body, active) => res.render('admin/layout', { title, body: String(body), actions: '', nav: NAV, active: active || '/portal' + (req.path === '/' ? '' : req.path), portal: true });
  const bookings = (cid) => h.all(`SELECT b.*, bay.code, bay.zone, bt.name boat FROM bookings b JOIN bays bay ON bay.id=b.bay_id LEFT JOIN boats bt ON bt.id=b.boat_id WHERE b.customer_id=? AND b.status IN ('confirmed','active','pending') ORDER BY start_date`, cid);

  r.get('/portal', (req, res) => {
    const c = h.get('SELECT * FROM customers WHERE id=?', req.cid);
    const bks = bookings(req.cid);
    const boats = h.all('SELECT * FROM boats WHERE customer_id=?', req.cid);
    const owing = h.get(`SELECT COALESCE(SUM(total-paid),0) v FROM invoices WHERE customer_id=? AND status IN ('issued','overdue')`, req.cid).v;
    const month = C.todaySyd().slice(0, 7);
    const upcoming = h.all(`SELECT l.*, bt.name boat FROM lifts l JOIN bookings b ON b.id=l.booking_id LEFT JOIN boats bt ON bt.id=l.boat_id WHERE b.customer_id=? AND l.date>=? AND l.status='booked' ORDER BY date, slot`, req.cid, C.todaySyd());
    page(req, res, `Hi ${c.name.split(' ')[0]}`, html`
      ${owing > 0 ? html`<div class="alert warn">You have ${money(owing)} outstanding. <a href="/portal/invoices">View and pay invoices</a></div>` : ''}
      <div class="kpis">${bks.map((b) => { const used = h.get(`SELECT COUNT(*) n FROM lifts WHERE booking_id=? AND substr(date,1,7)=? AND status<>'cancelled'`, b.id, month).n;
        return html`<div class="kpi"><div class="v">${b.package === 'standard' ? `${Math.max(0, 2 - used)} left` : 'Unlimited'}</div><div class="l">Lifts this month · ${b.boat}</div></div>`; })}
        <div class="kpi"><div class="v">${money(owing)}</div><div class="l">Balance owing</div></div></div>
      <div class="cols">
        <div class="card"><h2>Your storage</h2>${bks.length ? bks.map((b) => html`<dl class="kv" style="margin-bottom:12px"><dt>Boat</dt><dd><b>${b.boat}</b> ${pill(b.status)}</dd><dt>Bay</dt><dd>${b.code} · ${b.zone}</dd><dt>Package</dt><dd>${label(b.package)} · ${label(b.term)}</dd><dt>Monthly</dt><dd>${money(b.monthly_rate)} incl. GST</dd><dt>Contract</dt><dd>${d(b.start_date)} – ${d(b.end_date)}</dd><dt>Summary</dt><dd><a href="/booking/${b.ref}">${b.ref}</a></dd></dl>`) : html`<p class="muted">No active storage. <a href="/book">Get a quote</a>.</p>`}</div>
        <div class="card"><h2>Upcoming lifts <a class="btn btn-brand btn-sm" href="/portal/lifts">Book a lift</a></h2>${table([{ h: 'Date', f: (l) => d(l.date) }, { h: 'Time', k: 'slot' }, { h: 'Boat', k: 'boat' }, { h: '', f: (l) => l.is_extra ? pill('warn', 'Extra $30') : '' }], upcoming, 'No lifts booked.')}</div>
        <div class="card"><h2>Your boats</h2>${table([{ h: 'Boat', k: 'name' }, { h: 'Length', f: (b) => b.length_m + ' m' }, { h: 'Insurance expiry', f: (b) => d(b.insurance_expiry) || '—' }, { h: '', f: (b) => html`<a href="/portal/boats/${b.id}/sheet">Info sheet</a>` }], boats)}</div>
      </div>`, '/portal');
  });

  r.get('/portal/lifts', (req, res) => {
    const bks = bookings(req.cid).filter((b) => ['confirmed', 'active'].includes(b.status));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') && req.query.date >= C.todaySyd() ? req.query.date : C.addDays(C.todaySyd(), 1);
    const slots = S.liftSlots(h, date);
    page(req, res, 'Book a lift', html`<form class="card" method="get" style="max-width:640px"><div class="inline-form">${field('date', 'Date', { type: 'date', value: date, attrs: `min="${C.todaySyd()}"` })}<button class="btn btn-outline btn-sm">Check times</button></div></form>
      ${!bks.length ? html`<div class="alert warn">You need an active storage booking to book lifts.</div>` : slots.length ? html`<form class="card" method="post" action="/portal/lifts" style="max-width:640px"><h2>${d(date)}</h2>
        <input type="hidden" name="date" value="${date}">${field('booking_id', 'Boat', { options: bks.map((b) => [b.id, `${b.boat} (${label(b.package)})`]) })}
        <div class="choice-cards" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">${slots.map((s) => html`<label class="choice" style="${s.free <= 0 ? 'opacity:.5' : ''}"><input type="radio" name="slot" value="${s.slot}" ${raw(s.free <= 0 ? 'disabled' : '')} required><span><b>${s.slot}</b><span class="small muted">${s.free <= 0 ? 'Full' : 'Available'}</span></span></label>`)}</div>
        <label class="check small" style="margin-top:12px"><input type="checkbox" name="engine_flush" value="1"> Request an engine flush (Unlimited package)</label>
        ${field('notes', 'Notes for the yard (optional)')}
        <button class="btn btn-primary">Book lift</button><p class="small muted" style="margin-top:8px">Standard includes 2 lifts a month. Extra lifts are $30, added to next month’s invoice.</p></form>` : html`<div class="alert warn">No lifts on this day. Choose another date.</div>`}`);
  });
  r.post('/portal/lifts', (req, res) => {
    const b = h.get('SELECT * FROM bookings WHERE id=? AND customer_id=?', req.body.booking_id, req.cid);
    if (!b) return res.redirect('/portal/lifts');
    try {
      const x = S.bookLift(h, { booking_id: b.id, date: req.body.date, slot: req.body.slot, engine_flush: !!req.body.engine_flush, notes: req.body.notes, via: 'portal' }, req.user);
      app.locals.flash(res, x.extra ? 'Lift booked. This one is an extra lift ($30), added to next month’s invoice.' : 'Lift booked. We’ve emailed your confirmation.');
      res.redirect('/portal');
    } catch (e) { app.locals.flash(res, '!' + e.message); res.redirect('/portal/lifts?date=' + req.body.date); }
  });

  r.get('/portal/invoices', (req, res) => {
    const inv = h.all('SELECT * FROM invoices WHERE customer_id=? AND status<>? ORDER BY issue_date DESC', req.cid, 'void');
    page(req, res, 'Invoices', html`<div class="card">${table([{ h: 'Invoice', f: (i) => html`<a href="/portal/invoices/${i.id}">${i.number}</a>` }, { h: 'Issued', f: (i) => d(i.issue_date) }, { h: 'For', f: (i) => i.period === 'deposit' ? 'Reservation fee' : i.period }, { h: 'Total', num: 1, f: (i) => money(i.total) }, { h: 'Status', f: (i) => pill(i.status) },
      { h: '', f: (i) => ['issued', 'overdue'].includes(i.status) ? html`<a class="btn btn-primary btn-sm" href="/portal/invoices/${i.id}/pay">Pay ${money(i.total - i.paid)}</a>` : '' }], inv)}</div>`);
  });
  r.get('/portal/invoices/:id', (req, res, next) => {
    const i = h.get('SELECT * FROM invoices WHERE id=? AND customer_id=?', req.params.id, req.cid);
    if (!i) return next();
    page(req, res, 'Invoice ' + i.number, html`<div class="no-print" style="margin-bottom:12px;display:flex;gap:8px"><button class="btn btn-outline btn-sm" onclick="window.print()">Download PDF</button>${['issued', 'overdue'].includes(i.status) ? html`<a class="btn btn-primary btn-sm" href="/portal/invoices/${i.id}/pay">Pay now</a>` : ''}</div>${renderInvoice(h, i.id, res.locals.biz)}`, '/portal/invoices');
  });
  r.get('/portal/invoices/:id/pay', async (req, res, next) => {
    const i = h.get('SELECT i.*, c.email FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=? AND i.customer_id=?', req.params.id, req.cid);
    if (!i || !['issued', 'overdue'].includes(i.status)) return next();
    const amount = C.round2(i.total - i.paid);
    if (process.env.STRIPE_SECRET_KEY) {
      const base = h.setting('base_url');
      const form = new URLSearchParams({ mode: 'payment', customer_email: i.email, 'line_items[0][price_data][currency]': 'aud', 'line_items[0][price_data][unit_amount]': String(Math.round(amount * 100)),
        'line_items[0][price_data][product_data][name]': `Invoice ${i.number}`, 'line_items[0][quantity]': '1', 'metadata[invoice_id]': String(i.id), success_url: `${base}/portal/invoices/${i.id}?paid=1`, cancel_url: `${base}/portal/invoices/${i.id}` });
      const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
      const s = await resp.json();
      if (!resp.ok) return next(Object.assign(new Error(s.error?.message), { expose: true }));
      return res.redirect(303, s.url);
    }
    page(req, res, 'Pay invoice ' + i.number, html`<div class="card" style="max-width:520px"><div class="alert warn small">Demo payment mode: Stripe keys aren’t configured.</div>
      <div class="live-price"><span>Amount due</span><strong class="num">${money(amount)}</strong></div>
      <form method="post" action="/portal/invoices/${i.id}/pay">${field('cc', 'Card number', { value: '4242 4242 4242 4242', attrs: 'readonly' })}<button class="btn btn-primary btn-block">Pay ${money(amount)}</button></form></div>`, '/portal/invoices');
  });
  r.post('/portal/invoices/:id/pay', (req, res, next) => {
    if (process.env.STRIPE_SECRET_KEY) return next();
    const i = h.get('SELECT * FROM invoices WHERE id=? AND customer_id=?', req.params.id, req.cid);
    if (!i) return next();
    S.recordPayment(h, { invoice_id: i.id, customer_id: i.customer_id, amount: C.round2(i.total - i.paid), method: 'stripe', reference: 'demo_' + crypto.randomBytes(4).toString('hex') }, null);
    app.locals.flash(res, `Payment received for ${i.number}. Thank you.`); res.redirect('/portal/invoices');
  });

  r.get('/portal/checklists', (req, res) => {
    const rows = h.all('SELECT k.*, bt.name boat FROM checklists k JOIN boats bt ON bt.id=k.boat_id WHERE k.customer_id=? ORDER BY created_at DESC', req.cid);
    page(req, res, 'Condition reports', html`<div class="card">${table([{ h: 'When', f: (k) => html`<a href="/portal/checklists/${k.id}">${dt(k.created_at)}</a>` }, { h: 'Type', f: (k) => label(k.type) }, { h: 'Boat', k: 'boat' }], rows)}</div>`);
  });
  r.get('/portal/checklists/:id', (req, res, next) => {
    if (!h.get('SELECT 1 FROM checklists WHERE id=? AND customer_id=?', req.params.id, req.cid)) return next();
    page(req, res, 'Condition report', html`<div class="no-print" style="margin-bottom:12px"><button class="btn btn-outline btn-sm" onclick="window.print()">Download PDF</button></div>${renderChecklist(h, req.params.id)}`, '/portal/checklists');
  });
  r.get('/portal/boats/:id/sheet', async (req, res, next) => {
    const b = h.get('SELECT * FROM boats WHERE id=? AND customer_id=?', req.params.id, req.cid);
    if (!b) return next();
    const bk = h.get(`SELECT b.*, bay.code FROM bookings b JOIN bays bay ON bay.id=b.bay_id WHERE b.boat_id=? AND b.status IN ('confirmed','active') ORDER BY b.start_date DESC`, b.id);
    const qr = await QRCode.toDataURL(`${h.setting('base_url')}/q/${b.qr_token}`, { margin: 1, width: 360, color: { dark: '#17414E' } });
    page(req, res, 'Boat info sheet', html`<div class="no-print" style="margin-bottom:12px"><button class="btn btn-outline btn-sm" onclick="window.print()">Download PDF</button></div>
      <div class="card" style="max-width:760px;display:grid;grid-template-columns:1fr 200px;gap:20px"><div><img src="/static/img/logo-240.png" alt="Cockatoo Marine" style="height:56px;width:auto;margin-bottom:10px"><h2 style="font-size:1.6rem">${b.name}</h2>
        <dl class="kv"><dt>Make / model</dt><dd>${b.make_model}</dd><dt>Length</dt><dd>${b.length_m} m</dd><dt>HIN</dt><dd>${b.hin || '—'}</dd><dt>Rego</dt><dd>${b.rego || '—'}</dd><dt>Bay</dt><dd>${bk ? bk.code : '—'}</dd><dt>Insurance expiry</dt><dd>${d(b.insurance_expiry) || '—'}</dd></dl></div>
        <div style="text-align:center"><img src="${qr}" alt="QR code" style="width:180px;margin:0 auto"><p class="small muted">Yard staff scan this to open your boat’s record.</p></div></div>`, '/portal');
  });
  return r;
};
