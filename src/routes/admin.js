const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const C = require('../core');
const S = require('../services');
const { html, raw, pill, table, field, money, d, dt, label, esc } = require('../ui');

const ALL = ['admin', 'office', 'yard', 'finance'];
const NAV = [
  ['/admin', 'Dashboard', ALL], ['/admin/calendar', 'Calendar', ['admin', 'office', 'yard']],
  ['/admin/bookings', 'Bookings', ['admin', 'office']], ['/admin/leads', 'Leads', ['admin', 'office']],
  ['/admin/customers', 'Customers', ['admin', 'office', 'finance']], ['/admin/boats', 'Boats', ['admin', 'office', 'yard']],
  ['/admin/checklists', 'Checklists', ['admin', 'office', 'yard']], ['/admin/releases', 'Release log', ['admin', 'office', 'yard']],
  ['/admin/lifts', 'Lifts', ['admin', 'office', 'yard']], ['/admin/services', 'Service jobs', ['admin', 'office', 'yard']],
  ['/admin/maintenance', 'Maintenance', ['admin', 'office', 'yard']], ['/admin/bays', 'Bays', ['admin', 'office', 'yard']],
  ['/admin/invoices', 'Invoices', ['admin', 'office', 'finance']], ['/admin/expenses', 'Expenses', ['admin', 'finance']],
  ['/admin/reports', 'Reports', ['admin', 'office', 'finance']], ['/admin/watchlist', 'Watchlist', ['admin']],
  ['/admin/website', 'Website', ['admin', 'office']], ['/admin/import', 'Import', ['admin']], ['/admin/settings', 'Settings', ['admin']],
  ['/admin/outbox', 'Outbox', ['admin', 'office']], ['/admin/audit', 'Audit log', ['admin']],
];

const upload = multer({
  storage: multer.diskStorage({ destination: process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'),
    filename: (req, f, cb) => cb(null, crypto.randomBytes(10).toString('hex') + path.extname(f.originalname).toLowerCase().slice(0, 6)) }),
  limits: { fileSize: 12 * 1024 * 1024, files: 12 },
  fileFilter: (req, f, cb) => cb(null, /^(image\/|application\/pdf)/.test(f.mimetype)),
});

module.exports = (h, app) => {
  const r = express.Router();
  const flash = (res, msg) => app.locals.flash(res, msg);
  const can = (u, ...roles) => roles.includes(u.role);

  r.use((req, res, next) => {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (req.user.role === 'customer') return res.redirect('/portal');
    const entry = [...NAV].sort((a, b) => b[0].length - a[0].length).find((n) => ('/admin' + req.path).startsWith(n[0]));
    if (entry && !entry[2].includes(req.user.role)) return page(req, res, 'Not allowed', html`<div class="empty">Your role (${req.user.role}) does not have access to this area.</div>`);
    next();
  });

  function page(req, res, title, body, { actions = '', active } = {}) {
    const alerts = req.user.role === 'admin' ? h.get('SELECT COUNT(*) n FROM watch_alerts WHERE resolved=0').n : 0;
    const newLeads = h.get(`SELECT COUNT(*) n FROM leads WHERE stage='new'`).n;
    const nav = NAV.filter((n) => n[2].includes(req.user.role)).map(([href, l]) => [href, l, href === '/admin/watchlist' && alerts ? alerts : href === '/admin/leads' && newLeads ? newLeads : null]);
    const act = active || [...NAV].sort((a, b) => b[0].length - a[0].length).find((n) => ('/admin' + req.path).startsWith(n[0]))?.[0];
    res.render('admin/layout', { title, body: String(body), actions: String(actions), nav, active: act, portal: false });
  }
  const back = (req, res, msg) => { flash(res, '!' + msg); res.redirect(req.get('referer') || '/admin'); };
  const today = () => C.todaySyd();

  const custOptions = () => [['', 'Select customer…'], ...h.all('SELECT id,name FROM customers ORDER BY name').map((c) => [c.id, c.name])];
  const bayOptions = () => [['', 'Auto-assign smallest fitting bay'], ...h.all('SELECT id,code,max_length_m FROM bays ORDER BY code').map((b) => [b.id, `${b.code} (max ${b.max_length_m} m)`])];
  const bookingLink = (b) => html`<a href="/admin/bookings/${b.id}">${b.ref}</a>`;

  // ======================= DASHBOARD =======================
  r.get('/', (req, res) => {
    const t = today();
    const bays = h.get(`SELECT COUNT(*) n FROM bays WHERE status<>'out_of_service'`).n;
    const occupied = h.get(`SELECT COUNT(DISTINCT bay_id) n FROM bookings WHERE kind='storage' AND status IN ('confirmed','active') AND start_date<=? AND end_date>?`, t, t).n;
    const mrr = h.get(`SELECT COALESCE(SUM(monthly_rate),0) v FROM bookings WHERE kind='storage' AND status IN ('confirmed','active') AND start_date<=? AND end_date>?`, t, t).v;
    const pendingDep = h.all(`SELECT b.*, c.name FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.status IN ('pending','hold') ORDER BY b.created_at DESC`);
    const overdue = h.get(`SELECT COUNT(*) n, COALESCE(SUM(total-paid),0) v FROM invoices WHERE status='overdue'`);
    const lifts = h.all(`SELECT l.*, bt.name boat, c.name cname FROM lifts l LEFT JOIN boats bt ON bt.id=l.boat_id LEFT JOIN bookings b ON b.id=l.booking_id LEFT JOIN customers c ON c.id=b.customer_id WHERE l.date=? AND l.status<>'cancelled' ORDER BY slot`, t);
    const out = h.all(`SELECT r.*, bt.name boat FROM checklists r JOIN boats bt ON bt.id=r.boat_id WHERE r.type='release' AND NOT EXISTS (SELECT 1 FROM checklists x WHERE x.release_id=r.id) ORDER BY r.created_at DESC`);
    const freeNow = S.availableBays(h, 0, t, C.addDays(t, 1));
    const ending = h.all(`SELECT b.*, c.name, bay.code FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN bays bay ON bay.id=b.bay_id WHERE b.kind='storage' AND b.status IN ('confirmed','active') AND b.end_date BETWEEN ? AND ? ORDER BY b.end_date`, t, C.addDays(t, 90));
    const maint = h.all(`SELECT m.*, a.name asset FROM maintenance_jobs m JOIN assets a ON a.id=m.asset_id WHERE m.status<>'done' AND m.due_date<=? ORDER BY due_date`, C.addDays(t, 14));
    const alerts = can(req.user, 'admin') ? h.all(`SELECT a.*, w.name wname, w.reason FROM watch_alerts a JOIN watchlist w ON w.id=a.watch_id WHERE a.resolved=0 ORDER BY a.created_at DESC`) : [];
    const leadsNew = h.get(`SELECT COUNT(*) n FROM leads WHERE stage IN ('new','contacted','quoted')`).n;

    const body = html`
      ${alerts.length ? html`<div class="alert err"><strong>${alerts.length} watchlist alert${alerts.length > 1 ? 's' : ''}.</strong> ${alerts.map((a) => html`<div class="small">${a.entity} #${a.entity_id} resembles watchlist entry “${a.wname}” (${a.reason}) — ${a.detail}. <a href="/admin/${a.entity === 'lead' ? 'leads' : 'bookings'}/${a.entity_id}">Review</a></div>`)}</div>` : ''}
      <div class="kpis">
        <div class="kpi"><div class="v">${Math.round((occupied / bays) * 100)}%</div><div class="l">Occupancy (${occupied}/${bays} bays)</div></div>
        <div class="kpi"><div class="v">${money(mrr)}</div><div class="l">Monthly recurring revenue</div></div>
        <div class="kpi"><div class="v">${pendingDep.length}</div><div class="l">Awaiting deposit</div></div>
        <div class="kpi"><div class="v">${money(overdue.v)}</div><div class="l">Overdue (${overdue.n} invoices)</div></div>
        <div class="kpi"><div class="v">${leadsNew}</div><div class="l">Open leads</div></div>
        <div class="kpi"><div class="v">${freeNow.length}</div><div class="l">Bays free today</div></div>
      </div>
      <div class="cols">
        <div class="card"><h2>Today’s lifts <a class="btn btn-outline btn-sm" href="/admin/lifts">Lift board</a></h2>
          ${table([{ h: 'Time', k: 'slot' }, { h: 'Boat', k: 'boat' }, { h: 'Customer', k: 'cname' }, { h: '', f: (l) => html`${l.is_extra ? pill('warn', 'Extra $30') : ''} ${l.engine_flush ? pill('info', 'Engine flush') : ''} ${pill(l.status === 'booked' ? 'booked_lift' : l.status, label(l.status))}` }], lifts, 'No lifts booked today.')}</div>
        <div class="card"><h2>Boats out on the water</h2>
          ${table([{ h: 'Boat', f: (x) => html`<a href="/admin/boats/${x.boat_id}">${x.boat}</a>` }, { h: 'Released to', k: 'released_to' }, { h: 'Since', f: (x) => dt(x.created_at) }, { h: '', f: (x) => html`<a class="btn btn-outline btn-sm" href="/admin/checklists/new?type=return&boat=${x.boat_id}">Check in return</a>` }], out, 'All boats are in the yard.')}</div>
        <div class="card"><h2>Awaiting deposit / on hold</h2>
          ${table([{ h: 'Ref', f: bookingLink }, { h: 'Customer', k: 'name' }, { h: 'Status', f: (b) => pill(b.status) }, { h: 'Expires', f: (b) => dt(b.hold_expires_at || b.pending_expires_at) }], pendingDep, 'No bookings waiting on payment.')}</div>
        <div class="card"><h2>Ending or renewing in 90 days</h2>
          ${table([{ h: 'Ref', f: bookingLink }, { h: 'Customer', k: 'name' }, { h: 'Bay', k: 'code' }, { h: 'Ends', f: (b) => html`${d(b.end_date)} <span class="muted small">(${C.daysBetween(t, b.end_date)}d)</span>` }], ending, 'Nothing ending soon.')}</div>
        <div class="card"><h2>Maintenance due (14 days)</h2>
          ${table([{ h: 'Asset', k: 'asset' }, { h: 'Job', f: (m) => html`<a href="/admin/maintenance/${m.id}">${m.title}</a>` }, { h: 'Due', f: (m) => html`${d(m.due_date)} ${m.due_date < t ? pill('overdue', 'Overdue') : ''}` }], maint, 'Nothing due.')}</div>
        <div class="card"><h2>Free bays today <a class="btn btn-outline btn-sm" href="/admin/bays">Availability</a></h2>
          <p class="small">${freeNow.map((b) => b.code).join(', ') || 'None'}</p></div>
      </div>`;
    page(req, res, 'Dashboard', body, { actions: can(req.user, 'admin', 'office') ? html`<form method="post" action="/admin/jobs/run"><button class="btn btn-outline btn-sm">Run scheduled jobs now</button></form><a class="btn btn-brand btn-sm" href="/admin/bookings/new">New booking</a>` : '' });
  });

  r.post('/jobs/run', (req, res) => { const log = S.runScheduledJobs(h); flash(res, 'Jobs ran: ' + log.join(' · ')); res.redirect('/admin'); });

  // ======================= CALENDAR =======================
  r.get('/calendar', (req, res) => {
    const days = Math.min(Number(req.query.days) || 42, 120);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : C.addDays(today(), -7);
    const to = C.addDays(from, days);
    const zone = req.query.zone || '';
    const bays = h.all(`SELECT * FROM bays ${zone ? 'WHERE zone=?' : ''} ORDER BY code`, ...(zone ? [zone] : []));
    const bks = h.all(`SELECT b.*, c.name cname, bt.name boat FROM bookings b LEFT JOIN customers c ON c.id=b.customer_id LEFT JOIN boats bt ON bt.id=b.boat_id
      WHERE b.status IN ('hold','pending','confirmed','active','maintenance') AND (b.status<>'hold' OR b.hold_expires_at > ?) AND b.start_date < ? AND b.end_date > ?`, new Date().toISOString(), to, from);
    const t = today();
    const dates = Array.from({ length: days }, (_, i) => C.addDays(from, i));
    const cols = `grid-template-columns: 110px repeat(${days}, minmax(26px, 1fr))`;
    let grid = `<div class="tl-head" style="grid-column:1;position:sticky;left:0;z-index:3">Bay</div>`;
    dates.forEach((dd) => { const wd = new Date(dd + 'T00:00:00Z').getUTCDay(); grid += `<div class="tl-head ${dd === t ? 'today' : wd === 0 || wd === 6 ? 'we' : ''}" title="${dd}">${dd.slice(8)}${dd.slice(8) === '01' || dd === from ? '<br>' + new Date(dd + 'T00:00:00Z').toLocaleDateString('en-AU', { month: 'short', timeZone: 'UTC' }) : ''}</div>`; });
    bays.forEach((bay, i) => {
      const row = i + 2;
      grid += `<div class="tl-bay" style="grid-row:${row}">${esc(bay.code)}<small>${bay.max_length_m} m ${bay.status === 'out_of_service' ? '· out of service' : ''}</small></div>`;
      dates.forEach((_, j) => { grid += `<div class="tl-cell" style="grid-row:${row};grid-column:${j + 2};${bay.status === 'out_of_service' ? 'background:#F3E5E3' : ''}"></div>`; });
      for (const b of bks.filter((x) => x.bay_id === bay.id)) {
        const s = Math.max(0, C.daysBetween(from, b.start_date)), e = Math.min(days, C.daysBetween(from, b.end_date));
        const lbl = b.kind === 'maintenance' ? 'Maintenance: ' + (b.notes || '') : `${b.cname || ''} · ${b.boat || ''}`;
        grid += `<a class="tl-bar st-${b.status}" style="grid-row:${row};grid-column:${s + 2} / ${e + 2}" href="/admin/bookings/${b.id}" title="${esc(lbl)} (${b.start_date} → ${b.end_date}, ${b.status})">${esc(lbl)}</a>`;
      }
    });
    const zones = h.all('SELECT DISTINCT zone FROM bays ORDER BY zone').map((z) => z.zone);
    const body = html`
      <form class="filters" method="get">
        <div class="field"><label for="from">From</label><input type="date" id="from" name="from" value="${from}"></div>
        <div class="field"><label for="days">Range</label><select id="days" name="days">${[[14, '2 weeks'], [42, '6 weeks'], [90, '3 months'], [120, '4 months']].map(([v, l]) => html`<option value="${v}" ${raw(v === days ? 'selected' : '')}>${l}</option>`)}</select></div>
        <div class="field"><label for="zone">Zone</label><select id="zone" name="zone"><option value="">All zones</option>${zones.map((z) => html`<option ${raw(z === zone ? 'selected' : '')}>${z}</option>`)}</select></div>
        <button class="btn btn-brand btn-sm">Show</button>
        <a class="btn btn-outline btn-sm" href="?from=${C.addDays(from, -days)}&days=${days}&zone=${zone}">Earlier</a>
        <a class="btn btn-outline btn-sm" href="?from=${C.addDays(t, -7)}&days=${days}&zone=${zone}">Today</a>
        <a class="btn btn-outline btn-sm" href="?from=${C.addDays(from, days)}&days=${days}&zone=${zone}">Later</a>
      </form>
      <div class="legend"><span style="--c:var(--brand)">Active</span><span style="--c:var(--brand-mid)">Confirmed</span><span style="--c:#B7791F">Pending payment</span><span style="--c:#D69E2E">Online hold</span><span style="--c:#6B7280">Maintenance block</span></div>
      <div class="tl"><div class="tl-grid" style="${cols}">${raw(grid)}</div></div>
      <p class="small muted" style="margin-top:10px">Click a booking to move, extend or cancel it. Overlaps are rejected by the database, so a bay can never be double-booked.</p>`;
    page(req, res, 'Booking calendar', body, { actions: can(req.user, 'admin', 'office') ? html`<a class="btn btn-brand btn-sm" href="/admin/bookings/new">New booking</a><a class="btn btn-outline btn-sm" href="/admin/maintenance/new">Block a bay</a>` : '' });
  });

  // ======================= BAYS & AVAILABILITY =======================
  r.get('/bays', (req, res) => {
    const t = today();
    const bays = h.all(`SELECT bay.*, (SELECT b.id FROM bookings b WHERE b.bay_id=bay.id AND b.status IN ('confirmed','active','maintenance','pending','hold') AND b.start_date<=? AND b.end_date>? LIMIT 1) cur,
      (SELECT MIN(b.start_date) FROM bookings b WHERE b.bay_id=bay.id AND b.status IN ('confirmed','active','pending','maintenance') AND b.start_date>?) next_start,
      (SELECT MAX(b.end_date) FROM bookings b WHERE b.bay_id=bay.id AND b.status IN ('confirmed','active') AND b.start_date<=? AND b.end_date>?) frees_on FROM bays bay ORDER BY code`, t, t, t, t, t);
    const live = (b) => b.status === 'out_of_service' ? 'out_of_service' : b.cur ? (h.get('SELECT status FROM bookings WHERE id=?', b.cur).status === 'maintenance' ? 'maintenance' : 'occupied') : 'available';
    const win = (n) => bays.filter((b) => b.frees_on && C.daysBetween(t, b.frees_on) <= n).length;
    const body = html`
      <div class="kpis">
        <div class="kpi"><div class="v">${bays.filter((b) => live(b) === 'available').length}</div><div class="l">Free now</div></div>
        <div class="kpi"><div class="v">${win(30)}</div><div class="l">Free up within 30 days</div></div>
        <div class="kpi"><div class="v">${win(60)}</div><div class="l">Within 60 days</div></div>
        <div class="kpi"><div class="v">${win(90)}</div><div class="l">Within 90 days</div></div>
      </div>
      <div class="card">${table([
        { h: 'Bay', k: 'code' }, { h: 'Zone', k: 'zone' }, { h: 'Max length', f: (b) => `${b.max_length_m} m` },
        { h: 'Now', f: (b) => pill(live(b)) }, { h: 'Current booking', f: (b) => b.cur ? html`<a href="/admin/bookings/${b.cur}">View</a>` : '—' },
        { h: 'Frees up', f: (b) => d(b.frees_on) || '—' }, { h: 'Next booking', f: (b) => d(b.next_start) || '—' },
        { h: '', f: (b) => can(req.user, 'admin', 'office') ? html`<form method="post" action="/admin/bays/${b.id}" class="inline-form"><select name="status" aria-label="Set bay status">${['available', 'out_of_service'].map((s) => html`<option value="${s}" ${raw(b.status === s ? 'selected' : '')}>${label(s)}</option>`)}</select><button class="btn btn-outline btn-sm">Save</button></form>` : '' },
      ], bays)}</div>`;
    page(req, res, 'Bays & availability', body, { actions: can(req.user, 'admin') ? html`<a class="btn btn-outline btn-sm" href="/admin/bays/new">Add bay</a>` : '' });
  });
  r.get('/bays/new', (req, res) => page(req, res, 'Add bay', html`<form class="card" method="post" action="/admin/bays" style="max-width:520px">${field('code', 'Bay code', { required: true })}${field('zone', 'Zone', { required: true })}${field('max_length_m', 'Max boat length (m)', { type: 'number', attrs: 'step="0.1" min="1"', required: true })}<button class="btn btn-brand">Add bay</button></form>`));
  r.post('/bays', (req, res) => {
    if (!can(req.user, 'admin')) return back(req, res, 'Only admins can add bays.');
    try { const x = h.run('INSERT INTO bays (code,zone,max_length_m) VALUES (?,?,?)', req.body.code.trim().toUpperCase(), req.body.zone, Number(req.body.max_length_m)); S.audit(h, req.user, 'create', 'bay', Number(x.lastInsertRowid)); }
    catch (e) { return back(req, res, e.message.includes('UNIQUE') ? 'That bay code already exists.' : e.message); }
    flash(res, 'Bay added.'); res.redirect('/admin/bays');
  });
  r.post('/bays/:id', (req, res) => {
    if (!can(req.user, 'admin', 'office')) return back(req, res, 'Not allowed.');
    h.run('UPDATE bays SET status=? WHERE id=?', req.body.status === 'out_of_service' ? 'out_of_service' : 'available', req.params.id);
    S.audit(h, req.user, 'update', 'bay', Number(req.params.id), { status: req.body.status });
    flash(res, 'Bay updated.'); res.redirect('/admin/bays');
  });

  // ======================= BOOKINGS =======================
  r.get('/bookings', (req, res) => {
    const st = req.query.status || '';
    const q = `%${req.query.q || ''}%`;
    const rows = h.all(`SELECT b.*, c.name cname, bay.code, bt.name boat FROM bookings b LEFT JOIN customers c ON c.id=b.customer_id JOIN bays bay ON bay.id=b.bay_id LEFT JOIN boats bt ON bt.id=b.boat_id
      WHERE b.kind='storage' ${st ? 'AND b.status=?' : ''} AND (c.name LIKE ? OR b.ref LIKE ? OR bay.code LIKE ?) ORDER BY b.start_date DESC`, ...(st ? [st] : []), q, q, q);
    const body = html`
      <form class="filters"><input type="search" name="q" placeholder="Search name, ref or bay" value="${req.query.q || ''}" aria-label="Search">
        <select name="status" aria-label="Status"><option value="">All statuses</option>${['hold', 'pending', 'confirmed', 'active', 'completed', 'cancelled', 'expired'].map((s) => html`<option value="${s}" ${raw(s === st ? 'selected' : '')}>${label(s)}</option>`)}</select>
        <button class="btn btn-brand btn-sm">Filter</button></form>
      <div class="card">${table([
        { h: 'Ref', f: bookingLink }, { h: 'Customer', k: 'cname' }, { h: 'Boat', k: 'boat' }, { h: 'Bay', k: 'code' },
        { h: 'Package', f: (b) => `${label(b.package)} · ${label(b.term)}` }, { h: 'Dates', f: (b) => `${d(b.start_date)} – ${d(b.end_date)}` },
        { h: 'Rate', num: 1, f: (b) => money(b.monthly_rate) }, { h: 'Deposit', f: (b) => b.deposit_paid ? pill('paid', 'Paid') : pill('pending', 'Unpaid') }, { h: 'Status', f: (b) => pill(b.status) },
      ], rows)}</div>`;
    page(req, res, 'Bookings', body, { actions: html`<a class="btn btn-brand btn-sm" href="/admin/bookings/new">New booking</a>` });
  });

  r.get('/bookings/new', (req, res) => {
    const lead = req.query.lead ? h.get('SELECT * FROM leads WHERE id=?', req.query.lead) : null;
    const lq = lead?.quote_json ? JSON.parse(lead.quote_json) : {};
    const cid = req.query.customer || lead?.customer_id || '';
    const boats = cid ? h.all('SELECT id,name,length_m FROM boats WHERE customer_id=?', cid) : [];
    const body = html`
      ${lead && !lead.customer_id ? html`<div class="alert info">This lead has no customer record yet. <form method="post" action="/admin/leads/${lead.id}/customer" style="display:inline"><button class="btn btn-brand btn-sm">Create customer from lead</button></form></div>` : ''}
      <form class="card" method="get" style="max-width:760px"><h2>1. Customer</h2><div class="inline-form">${field('customer', 'Customer', { options: custOptions(), value: cid })}${lead ? html`<input type="hidden" name="lead" value="${lead.id}">` : ''}<button class="btn btn-outline btn-sm">Load boats</button></div>
        <p class="small muted">New customer? <a href="/admin/customers/new">Add customer</a> first.</p></form>
      ${cid ? html`<form class="card" method="post" action="/admin/bookings" style="max-width:760px"><h2>2. Booking</h2>
        <input type="hidden" name="customer_id" value="${cid}"><input type="hidden" name="lead_id" value="${lead?.id || ''}">
        ${boats.length ? field('boat_id', 'Boat', { options: boats.map((b) => [b.id, `${b.name} (${b.length_m} m)`]), required: true }) : html`<div class="alert warn">This customer has no boats. <a href="/admin/boats/new?customer=${cid}">Add a boat</a>.</div>`}
        <div class="row">${field('package', 'Package', { options: ['standard', 'unlimited'], value: lq.pkg })}${field('term', 'Term', { options: ['annual', 'monthly'], value: lq.term })}</div>
        <div class="row">${field('start_date', 'Start date', { type: 'date', value: lq.start || today(), required: true })}${field('months', 'Months (monthly term, min 3)', { type: 'number', value: 3, attrs: 'min="3"' })}</div>
        ${field('bay_id', 'Bay', { options: bayOptions() })}
        <div class="row">${field('monthly_rate', 'Monthly rate override (blank = rate table)', { type: 'number', attrs: 'step="0.01"' })}${field('status', 'Status', { options: [['pending', 'Pending payment (deposit not yet received)'], ['confirmed', 'Confirmed (deposit received)']] })}</div>
        ${field('notes', 'Notes', { type: 'textarea' })}
        <button class="btn btn-brand" ${raw(boats.length ? '' : 'disabled')}>Create booking</button></form>` : ''}`;
    page(req, res, 'New booking', body, { active: '/admin/bookings' });
  });

  r.post('/bookings', (req, res) => {
    const b = req.body;
    try {
      const boat = h.get('SELECT * FROM boats WHERE id=? AND customer_id=?', b.boat_id, b.customer_id);
      if (!boat) throw new Error('Choose one of the customer’s boats.');
      if (b.term === 'monthly' && Number(b.months) < 3) throw new Error('Monthly bookings have a 3-month minimum.');
      const q = S.getQuote(h, { lengthM: boat.length_m, pkg: b.package, term: b.term, months: b.months });
      const pendingDays = Number(h.setting('pending_days', 3));
      const bk = S.createBooking(h, { lengthM: boat.length_m, bay_id: b.bay_id || null, customer_id: Number(b.customer_id), boat_id: boat.id, lead_id: b.lead_id || null,
        package: b.package, term: b.term, monthly_rate: b.monthly_rate ? Number(b.monthly_rate) : q.monthly, start_date: b.start_date,
        end_date: S.bookingEnd(b.start_date, b.term, b.months), status: 'pending', deposit_amount: q.deposit,
        pending_expires_at: new Date(Date.now() + pendingDays * 86400e3).toISOString(), notes: b.notes }, req.user);
      if (b.lead_id) h.run(`UPDATE leads SET stage='deposit_pending', customer_id=? WHERE id=?`, b.customer_id, b.lead_id);
      S.screenWatchlist(h, 'booking', bk.id, { ...h.get('SELECT * FROM customers WHERE id=?', b.customer_id), rego: boat.rego, hin: boat.hin });
      if (b.status === 'confirmed') S.confirmBooking(h, bk.id, { amount: q.deposit, method: 'bank_transfer', reference: 'Recorded at booking', paid_on: today() }, req.user);
      flash(res, `Booking ${bk.ref} created.`); res.redirect('/admin/bookings/' + bk.id);
    } catch (e) { back(req, res, e.message); }
  });

  r.get('/bookings/:id', (req, res, next) => {
    const b = h.get(`SELECT b.*, c.name cname, c.email, c.phone, bay.code, bay.zone, bt.name boat, bt.length_m FROM bookings b LEFT JOIN customers c ON c.id=b.customer_id JOIN bays bay ON bay.id=b.bay_id LEFT JOIN boats bt ON bt.id=b.boat_id WHERE b.id=?`, req.params.id);
    if (!b) return next();
    const edit = can(req.user, 'admin', 'office');
    const history = h.all(`SELECT * FROM audit_log WHERE entity='booking' AND entity_id=? ORDER BY at DESC`, b.id);
    const inv = h.all('SELECT * FROM invoices WHERE booking_id=? ORDER BY issue_date DESC', b.id);
    const lifts = h.all('SELECT * FROM lifts WHERE booking_id=? ORDER BY date DESC LIMIT 20', b.id);
    const alerts = can(req.user, 'admin') ? h.all(`SELECT a.*, w.name wname, w.reason FROM watch_alerts a JOIN watchlist w ON w.id=a.watch_id WHERE a.entity='booking' AND a.entity_id=?`, b.id) : [];
    const body = html`
      ${alerts.map((a) => html`<div class="alert err"><strong>Watchlist match:</strong> ${a.detail} — “${a.wname}” (${a.reason}). Verify identity before proceeding. Do not disclose this to the customer. <a href="/admin/watchlist">Open watchlist</a></div>`)}
      <div class="cols">
        <div class="card"><h2>${b.kind === 'maintenance' ? 'Maintenance block' : 'Booking ' + b.ref} ${pill(b.status)}</h2>
          <dl class="kv">
            ${b.kind === 'storage' ? html`<dt>Customer</dt><dd><a href="/admin/customers/${b.customer_id}">${b.cname}</a> · ${b.phone} · ${b.email}</dd>
            <dt>Boat</dt><dd><a href="/admin/boats/${b.boat_id}">${b.boat}</a> (${b.length_m} m)</dd>
            <dt>Package / term</dt><dd>${label(b.package)} · ${label(b.term)}</dd><dt>Monthly rate</dt><dd>${money(b.monthly_rate)} incl. GST</dd>
            <dt>Deposit</dt><dd>${money(b.deposit_amount)} ${b.deposit_paid ? pill('paid', 'Paid') : pill('pending', 'Unpaid')}</dd>` : ''}
            <dt>Bay</dt><dd>${b.code} · ${b.zone}</dd><dt>Dates</dt><dd>${d(b.start_date)} → ${d(b.end_date)}</dd>
            ${b.hold_expires_at ? html`<dt>Hold expires</dt><dd>${dt(b.hold_expires_at)}</dd>` : ''}${b.pending_expires_at ? html`<dt>Payment due by</dt><dd>${dt(b.pending_expires_at)}</dd>` : ''}
            <dt>Notes</dt><dd>${b.notes || '—'}</dd>
          </dl>
          ${b.kind === 'storage' ? html`<p style="margin-top:14px"><a class="btn btn-outline btn-sm" href="/booking/${b.ref}" target="_blank">Customer summary / PDF</a></p>` : ''}
        </div>
        ${edit && b.kind === 'storage' && !b.deposit_paid && ['pending', 'hold'].includes(b.status) ? html`<form class="card" method="post" action="/admin/bookings/${b.id}/pay"><h2>Mark deposit paid</h2>
          <div class="row">${field('amount', 'Amount', { type: 'number', value: b.deposit_amount, attrs: 'step="0.01"', required: true })}${field('method', 'Method', { options: [['bank_transfer', 'Bank transfer'], ['card_phone', 'Card over the phone'], ['cash', 'Cash']] })}</div>
          <div class="row">${field('reference', 'Reference', { required: true })}${field('paid_on', 'Date received', { type: 'date', value: today() })}</div>
          <button class="btn btn-brand">Confirm booking</button></form>` : ''}
        ${edit ? html`<form class="card" method="post" action="/admin/bookings/${b.id}/edit"><h2>Move, extend or cancel</h2>
          ${field('bay_id', 'Bay', { options: h.all('SELECT id,code,max_length_m FROM bays ORDER BY code').map((x) => [x.id, `${x.code} (max ${x.max_length_m} m)`]), value: b.bay_id })}
          <div class="row">${field('start_date', 'Start', { type: 'date', value: b.start_date })}${field('end_date', 'End', { type: 'date', value: b.end_date })}</div>
          ${field('status', 'Status', { options: b.kind === 'maintenance' ? ['maintenance', 'completed', 'cancelled'] : ['hold', 'pending', 'confirmed', 'active', 'completed', 'cancelled', 'expired'], value: b.status })}
          ${field('reason', 'Reason for change (audited)', { required: true })}
          <button class="btn btn-brand">Save changes</button></form>` : ''}
      </div>
      ${b.kind === 'storage' ? html`<div class="cols">
        <div class="card"><h2>Invoices</h2>${table([{ h: 'Number', f: (i) => html`<a href="/admin/invoices/${i.id}">${i.number}</a>` }, { h: 'Period', k: 'period' }, { h: 'Total', num: 1, f: (i) => money(i.total) }, { h: 'Status', f: (i) => pill(i.status) }], inv)}</div>
        <div class="card"><h2>Lifts <a class="btn btn-outline btn-sm" href="/admin/lifts?booking=${b.id}">Book lift</a></h2>${table([{ h: 'Date', f: (l) => d(l.date) }, { h: 'Slot', k: 'slot' }, { h: '', f: (l) => html`${l.is_extra ? pill('warn', 'Extra') : ''} ${pill(l.status === 'booked' ? 'booked_lift' : l.status, label(l.status))}` }], lifts)}</div>
      </div>` : ''}
      <div class="card"><h2>Change history</h2>${table([{ h: 'When', f: (a) => dt(a.at) }, { h: 'Who', k: 'user_name' }, { h: 'Action', k: 'action' }, { h: 'Reason', k: 'reason' }, { h: 'Detail', f: (a) => html`<span class="small">${a.detail}</span>` }], history)}</div>`;
    page(req, res, b.kind === 'maintenance' ? 'Maintenance block' : `Booking ${b.ref}`, body, { active: b.kind === 'maintenance' ? '/admin/calendar' : '/admin/bookings' });
  });

  r.post('/bookings/:id/pay', (req, res) => {
    if (!can(req.user, 'admin', 'office')) return back(req, res, 'Not allowed.');
    const { amount, method, reference, paid_on } = req.body;
    if (!(Number(amount) > 0) || !reference) return back(req, res, 'Enter the amount and a payment reference.');
    try { S.confirmBooking(h, Number(req.params.id), { amount: Number(amount), method, reference, paid_on }, req.user); }
    catch (e) { return back(req, res, e.message); }
    flash(res, 'Deposit recorded. Booking confirmed and confirmation emailed.'); res.redirect('/admin/bookings/' + req.params.id);
  });

  r.post('/bookings/:id/edit', (req, res) => {
    if (!can(req.user, 'admin', 'office')) return back(req, res, 'Not allowed.');
    const { bay_id, start_date, end_date, status, reason } = req.body;
    if (!reason) return back(req, res, 'Give a reason for the change.');
    if (end_date <= start_date) return back(req, res, 'End date must be after the start date.');
    try { S.updateBooking(h, Number(req.params.id), { bay_id: Number(bay_id), start_date, end_date, status }, req.user, reason); }
    catch (e) { return back(req, res, e.message); }
    flash(res, 'Booking updated.'); res.redirect('/admin/bookings/' + req.params.id);
  });

  // ======================= LEADS / CRM PIPELINE =======================
  const STAGES = ['new', 'contacted', 'quoted', 'deposit_pending', 'booked', 'lost'];
  r.get('/leads', (req, res) => {
    const svc = req.query.service || '';
    const leads = h.all(`SELECT * FROM leads ${svc ? 'WHERE service=?' : ''} ORDER BY created_at DESC`, ...(svc ? [svc] : []));
    const flagged = new Set(h.all(`SELECT entity_id FROM watch_alerts WHERE entity='lead' AND resolved=0`).map((a) => a.entity_id));
    const body = html`
      <form class="filters"><select name="service" aria-label="Service"><option value="">All services</option>${['storage', 'antifoul', 'marina', 'commercial', 'barging', 'events', 'other'].map((s) => html`<option ${raw(s === svc ? 'selected' : '')}>${s}</option>`)}</select><button class="btn btn-brand btn-sm">Filter</button></form>
      <div class="kanban">${STAGES.map((s) => { const ls = leads.filter((l) => l.stage === s); return html`<div class="kcol"><h3>${label(s)} <span class="muted">${ls.length}</span></h3>
        ${ls.slice(0, 30).map((l) => html`<a class="kcard" href="/admin/leads/${l.id}"><b>${l.name}</b><span class="muted small">${label(l.service)} · ${l.source} · ${d(l.created_at.slice(0, 10))}</span>
          ${can(req.user, 'admin') && flagged.has(l.id) ? html`<div>${pill('err', 'Watchlist match')}</div>` : ''}</a>`)}</div>`; })}</div>`;
    page(req, res, 'Leads pipeline', body, { actions: html`<a class="btn btn-brand btn-sm" href="/admin/leads/new">Log enquiry</a>` });
  });

  r.get('/leads/new', (req, res) => page(req, res, 'Log an enquiry', html`<form class="card" method="post" action="/admin/leads" style="max-width:720px">
    <p class="muted">Use this for Facebook / Messenger, phone and walk-in enquiries so every lead lives in one place.</p>
    <div class="row">${field('source', 'Source', { options: ['facebook', 'messenger', 'phone', 'walk-in', 'email', 'website', 'referral'] })}${field('service', 'Service', { options: ['storage', 'antifoul', 'marina', 'commercial', 'barging', 'events', 'other'] })}</div>
    ${field('name', 'Name', { required: true })}<div class="row">${field('email', 'Email', { type: 'email' })}${field('phone', 'Phone')}</div>
    <div class="row">${field('length', 'Boat length (m), if storage', { type: 'number', attrs: 'step="0.1"' })}${field('rego', 'Rego / HIN (optional)')}</div>
    ${field('message', 'What did they ask for?', { type: 'textarea' })}<button class="btn btn-brand">Save lead</button></form>`, { active: '/admin/leads' }));

  r.post('/leads', (req, res) => {
    const b = req.body;
    if (!b.name) return back(req, res, 'Enter a name.');
    const id = S.createLead(h, { name: b.name, email: b.email, phone: b.phone, service: b.service, source: b.source, message: b.message,
      quote: b.length ? { lengthM: Number(b.length) } : null }, req.user);
    if (b.rego) S.screenWatchlist(h, 'lead', id, { rego: b.rego, hin: b.rego });
    flash(res, 'Lead saved.'); res.redirect('/admin/leads/' + id);
  });

  r.get('/leads/:id', (req, res, next) => {
    const l = h.get('SELECT * FROM leads WHERE id=?', req.params.id);
    if (!l) return next();
    const q = l.quote_json ? JSON.parse(l.quote_json) : null;
    const comms = h.all('SELECT cm.*, u.name uname FROM communications cm LEFT JOIN users u ON u.id=cm.user_id WHERE cm.lead_id=? OR (cm.customer_id IS NOT NULL AND cm.customer_id=?) ORDER BY created_at DESC', l.id, l.customer_id ?? -1);
    const alerts = can(req.user, 'admin') ? h.all(`SELECT a.*, w.name wname, w.reason FROM watch_alerts a JOIN watchlist w ON w.id=a.watch_id WHERE a.entity='lead' AND a.entity_id=?`, l.id) : [];
    const body = html`
      ${alerts.map((a) => html`<div class="alert err"><strong>Watchlist match:</strong> ${a.detail} — “${a.wname}” (${a.reason}). Staff only; do not disclose. <form method="post" action="/admin/watchlist/alerts/${a.id}/resolve" style="display:inline"><button class="btn btn-outline btn-sm">Mark reviewed</button></form></div>`)}
      <div class="cols">
        <div class="card"><h2>${l.name} ${pill(l.stage)}</h2><dl class="kv">
          <dt>Service</dt><dd>${label(l.service)}</dd><dt>Source</dt><dd>${l.source}</dd><dt>Email</dt><dd>${l.email || '—'}</dd><dt>Phone</dt><dd>${l.phone || '—'}</dd>
          <dt>Received</dt><dd>${dt(l.created_at)}</dd><dt>Message</dt><dd>${l.message || '—'}</dd>
          ${q ? html`<dt>Quote</dt><dd>${q.lengthM} m · ${label(q.pkg || '')} · ${label(q.term || '')} ${q.monthly ? html` · <b>${money(q.monthly)}/mo</b>` : ''} ${q.start ? ` · from ${d(q.start)}` : ''}${q.boat ? html`<br><span class="small muted">${q.boat.make_model} ${q.boat.trailer ? '· trailer' : ''} ${q.boat.rego || ''}</span>` : ''}</dd>` : ''}
          ${l.lost_reason ? html`<dt>Lost reason</dt><dd>${l.lost_reason}</dd>` : ''}
          <dt>Customer</dt><dd>${l.customer_id ? html`<a href="/admin/customers/${l.customer_id}">Open customer</a>` : html`<form method="post" action="/admin/leads/${l.id}/customer"><button class="btn btn-outline btn-sm">Create customer</button></form>`}</dd>
        </dl>
        ${l.service === 'storage' ? html`<p style="margin-top:14px"><a class="btn btn-brand btn-sm" href="/admin/bookings/new?lead=${l.id}">Convert to booking</a></p>` : ''}</div>
        <form class="card" method="post" action="/admin/leads/${l.id}/stage"><h2>Move stage</h2>
          ${field('stage', 'Stage', { options: STAGES, value: l.stage })}${field('lost_reason', 'Lost reason (if lost)', { value: l.lost_reason })}<button class="btn btn-brand">Update</button></form>
        <form class="card" method="post" action="/admin/leads/${l.id}/comm"><h2>Log contact</h2>
          <div class="row">${field('channel', 'Channel', { options: ['phone', 'email', 'messenger', 'sms', 'in person'] })}${field('direction', 'Direction', { options: [['out', 'Outbound'], ['in', 'Inbound']] })}</div>
          ${field('summary', 'Summary', { type: 'textarea', required: true })}<button class="btn btn-brand">Save</button></form>
      </div>
      <div class="card"><h2>Communications</h2>${table([{ h: 'When', f: (c) => dt(c.created_at) }, { h: 'Channel', k: 'channel' }, { h: 'Dir', k: 'direction' }, { h: 'Summary', k: 'summary' }, { h: 'By', k: 'uname' }], comms)}</div>`;
    page(req, res, 'Lead', body, { active: '/admin/leads' });
  });
  r.post('/leads/:id/stage', (req, res) => {
    const { stage, lost_reason } = req.body;
    if (!STAGES.includes(stage)) return back(req, res, 'Unknown stage.');
    if (stage === 'lost' && !lost_reason) return back(req, res, 'Give a reason when marking a lead lost.');
    h.run('UPDATE leads SET stage=?, lost_reason=?, updated_at=? WHERE id=?', stage, lost_reason || null, new Date().toISOString(), req.params.id);
    S.audit(h, req.user, 'update', 'lead', Number(req.params.id), { stage, lost_reason });
    flash(res, 'Lead updated.'); res.redirect('/admin/leads/' + req.params.id);
  });
  r.post('/leads/:id/comm', (req, res) => {
    const l = h.get('SELECT * FROM leads WHERE id=?', req.params.id);
    h.run('INSERT INTO communications (customer_id,lead_id,channel,direction,summary,user_id) VALUES (?,?,?,?,?,?)', l.customer_id, l.id, req.body.channel, req.body.direction, req.body.summary, req.user.id);
    if (l.stage === 'new') h.run(`UPDATE leads SET stage='contacted' WHERE id=?`, l.id);
    flash(res, 'Contact logged.'); res.redirect('/admin/leads/' + l.id);
  });
  r.post('/leads/:id/customer', (req, res) => {
    const l = h.get('SELECT * FROM leads WHERE id=?', req.params.id);
    const c = S.upsertCustomer(h, { name: l.name, email: l.email, phone: l.phone, source: l.source }, req.user);
    h.run('UPDATE leads SET customer_id=? WHERE id=?', c.id, l.id);
    const q = l.quote_json ? JSON.parse(l.quote_json) : null;
    if (q?.lengthM && !h.get('SELECT 1 FROM boats WHERE customer_id=?', c.id))
      h.run('INSERT INTO boats (customer_id,name,type,make_model,length_m,rego,hin,trailer,qr_token) VALUES (?,?,?,?,?,?,?,?,?)', c.id, q.boat?.make_model || 'Boat', q.boat?.type || null, q.boat?.make_model || null, q.lengthM, q.boat?.rego || null, q.boat?.hin || null, q.boat?.trailer ? 1 : 0, crypto.randomBytes(12).toString('base64url'));
    flash(res, 'Customer created.'); res.redirect(req.get('referer') || '/admin/customers/' + c.id);
  });

  require('./admin-crm')(r, h, { page, back, flash, can, today, upload, QRCode, custOptions });
  require('./admin-ops')(r, h, { page, back, flash, can, today, upload, custOptions });
  require('./admin-finance')(r, h, { page, back, flash, can, today, upload, custOptions });
  require('./admin-cms')(r, h, { page, back, flash, can });
  return r;
};
