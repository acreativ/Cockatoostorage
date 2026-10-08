// Customers, boats (with QR info sheet), checklists and the release log.
const crypto = require('node:crypto');
const C = require('../core');
const S = require('../services');
const { html, raw, pill, table, field, money, d, dt, label } = require('../ui');

module.exports = (r, h, { page, back, flash, can, today, upload, QRCode }) => {
  const bookingLink = (b) => html`<a href="/admin/bookings/${b.id}">${b.ref}</a>`;

  // ======================= CUSTOMERS =======================
  r.get('/customers', async (req, res) => {
    const q = `%${req.query.q || ''}%`;
    const rows = await h.all(`SELECT c.*, (SELECT COUNT(*) FROM boats b WHERE b.customer_id=c.id) boats,
      (SELECT COALESCE(SUM(total-paid),0) FROM invoices i WHERE i.customer_id=c.id AND i.status IN ('issued','overdue')) owing
      FROM customers c WHERE c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.company LIKE ? ORDER BY c.name`, q, q, q, q);
    await page(req, res, 'Customers', html`<form class="filters"><input type="search" name="q" placeholder="Search name, email, phone" value="${req.query.q || ''}" aria-label="Search"><button class="btn btn-brand btn-sm">Search</button></form>
      <div class="card">${table([{ h: 'Name', f: (c) => html`<a href="/admin/customers/${c.id}">${c.name}</a>` }, { h: 'Type', f: (c) => label(c.kind) }, { h: 'Email', k: 'email' }, { h: 'Phone', k: 'phone' },
        { h: 'Source', k: 'source' }, { h: 'Boats', k: 'boats', num: 1 }, { h: 'Owing', num: 1, f: (c) => c.owing > 0 ? money(c.owing) : '—' }], rows)}</div>`,
      { actions: can(req.user, 'admin', 'office') ? html`<a class="btn btn-brand btn-sm" href="/admin/customers/new">Add customer</a>` : '' });
  });

  const custForm = (c = {}) => html`
    <div class="row">${field('kind', 'Type', { options: ['individual', 'company'], value: c.kind })}${field('source', 'Source', { options: ['website', 'facebook', 'messenger', 'phone', 'walk-in', 'referral', 'import'], value: c.source })}</div>
    <div class="row">${field('name', 'Name', { required: true, value: c.name })}${field('company', 'Company', { value: c.company })}</div>
    <div class="row">${field('email', 'Email', { type: 'email', value: c.email })}${field('phone', 'Phone', { value: c.phone })}</div>
    ${field('address', 'Address', { value: c.address })}
    <div class="row">${field('billing_address', 'Billing address', { value: c.billing_address })}${field('abn', 'ABN (companies)', { value: c.abn })}</div>
    ${field('id_notes', 'ID / verification notes', { value: c.id_notes, hint: 'Record that ID was sighted, not ID numbers.' })}
    ${field('tags', 'Tags (comma separated)', { value: c.tags })}${field('notes', 'Notes', { type: 'textarea', value: c.notes })}`;
  const CUST_COLS = ['kind', 'source', 'name', 'company', 'email', 'phone', 'address', 'billing_address', 'abn', 'id_notes', 'tags', 'notes'];

  r.get('/customers/new', async (req, res) => await page(req, res, 'Add customer', html`<form class="card" method="post" action="/admin/customers" style="max-width:760px">${custForm()}<button class="btn btn-brand">Save customer</button></form>`, { active: '/admin/customers' }));
  r.post('/customers', async (req, res) => {
    if (!req.body.name) return back(req, res, 'Enter a name.');
    const x = await h.run(`INSERT INTO customers (${CUST_COLS}) VALUES (${CUST_COLS.map(() => '?')})`, ...CUST_COLS.map((k) => req.body[k] || null));
    const id = Number(x.lastInsertRowid);
    await S.audit(h, req.user, 'create', 'customer', id);
    await S.screenWatchlist(h, 'customer', id, req.body);
    flash(res, 'Customer saved.'); res.redirect('/admin/customers/' + id);
  });
  r.post('/customers/:id', async (req, res) => {
    if (!can(req.user, 'admin', 'office')) return back(req, res, 'Not allowed.');
    await h.run(`UPDATE customers SET ${CUST_COLS.map((k) => k + '=?')} WHERE id=?`, ...CUST_COLS.map((k) => req.body[k] || null), req.params.id);
    await S.audit(h, req.user, 'update', 'customer', Number(req.params.id));
    flash(res, 'Customer updated.'); res.redirect('/admin/customers/' + req.params.id);
  });

  r.get('/customers/:id', async (req, res, next) => {
    const c = await h.get('SELECT * FROM customers WHERE id=?', req.params.id);
    if (!c) return next();
    const tab = req.query.tab || 'overview';
    const boats = await h.all('SELECT * FROM boats WHERE customer_id=?', c.id);
    const bookings = await h.all('SELECT b.*, bay.code FROM bookings b JOIN bays bay ON bay.id=b.bay_id WHERE customer_id=? ORDER BY start_date DESC', c.id);
    const inv = await h.all('SELECT * FROM invoices WHERE customer_id=? ORDER BY issue_date DESC', c.id);
    const pays = await h.all('SELECT * FROM payments WHERE customer_id=? ORDER BY paid_on DESC', c.id);
    const leads = await h.all('SELECT * FROM leads WHERE customer_id=? ORDER BY created_at DESC', c.id);
    const contracts = await h.all('SELECT * FROM contracts WHERE customer_id=? ORDER BY start_date DESC', c.id);
    const lifts = await h.all('SELECT l.* FROM lifts l JOIN bookings b ON b.id=l.booking_id WHERE b.customer_id=? ORDER BY date DESC', c.id);
    const checks = await h.all('SELECT k.*, bt.name boat FROM checklists k JOIN boats bt ON bt.id=k.boat_id WHERE k.customer_id=? ORDER BY k.created_at DESC', c.id);
    const comms = await h.all('SELECT cm.*, u.name uname FROM communications cm LEFT JOIN users u ON u.id=cm.user_id WHERE cm.customer_id=? ORDER BY created_at DESC', c.id);
    const mail = await h.all('SELECT * FROM outbox WHERE customer_id=? OR recipient=? ORDER BY created_at DESC', c.id, c.email || '-');
    const owing = inv.filter((i) => ['issued', 'overdue'].includes(i.status)).reduce((s, i) => s + i.total - i.paid, 0);
    const tabs = [['overview', 'Overview'], ['bookings', `Bookings (${bookings.length})`], ['billing', `Invoices & payments (${inv.length})`], ['activity', 'Lifts & checklists'], ['comms', `Communications (${comms.length + mail.length})`], ['edit', 'Edit']];
    let body;
    if (tab === 'overview') body = html`<div class="cols">
      <div class="card"><h2>${c.name} ${c.tags ? c.tags.split(',').filter(Boolean).map((t) => pill('info', t.trim())) : ''}</h2><dl class="kv">
        <dt>Type</dt><dd>${label(c.kind)}${c.company ? ' · ' + c.company : ''}</dd><dt>Email</dt><dd>${c.email}</dd><dt>Phone</dt><dd>${c.phone}</dd><dt>Address</dt><dd>${c.address || '—'}</dd>
        <dt>Source</dt><dd>${c.source}</dd><dt>ID notes</dt><dd>${c.id_notes || '—'}</dd><dt>Balance owing</dt><dd><b>${money(owing)}</b></dd><dt>Notes</dt><dd>${c.notes || '—'}</dd></dl></div>
      <div class="card"><h2>Boats <a class="btn btn-outline btn-sm" href="/admin/boats/new?customer=${c.id}">Add boat</a></h2>${table([{ h: 'Boat', f: (b) => html`<a href="/admin/boats/${b.id}">${b.name}</a>` }, { h: 'Make / model', k: 'make_model' }, { h: 'Length', f: (b) => b.length_m + ' m' }, { h: 'Insurance', f: (b) => b.insurance_expiry ? html`${d(b.insurance_expiry)} ${b.insurance_expiry < C.addDays(today(), 30) ? pill('warn', 'Due') : ''}` : '—' }], boats)}</div>
      <div class="card"><h2>Contracts</h2>${table([{ h: 'Term', f: (k) => `${label(k.package)} · ${label(k.term)}` }, { h: 'Dates', f: (k) => `${d(k.start_date)} – ${d(k.end_date)}` }, { h: 'Rate', num: 1, f: (k) => money(k.monthly_rate) }, { h: 'T&Cs', f: (k) => html`${k.tc_version} <span class="small muted">${dt(k.tc_accepted_at)}</span>` }], contracts)}</div>
      <div class="card"><h2>Enquiries</h2>${table([{ h: 'When', f: (l) => d(l.created_at.slice(0, 10)) }, { h: 'Service', f: (l) => html`<a href="/admin/leads/${l.id}">${label(l.service)}</a>` }, { h: 'Source', k: 'source' }, { h: 'Stage', f: (l) => pill(l.stage) }], leads)}</div></div>`;
    if (tab === 'bookings') body = html`<div class="card">${table([{ h: 'Ref', f: bookingLink }, { h: 'Bay', k: 'code' }, { h: 'Package', f: (b) => `${label(b.package)} · ${label(b.term)}` }, { h: 'Dates', f: (b) => `${d(b.start_date)} – ${d(b.end_date)}` }, { h: 'Status', f: (b) => pill(b.status) }], bookings)}</div>`;
    if (tab === 'billing') body = html`<div class="card"><h2>Invoices</h2>${table([{ h: 'Number', f: (i) => html`<a href="/admin/invoices/${i.id}">${i.number}</a>` }, { h: 'Issued', f: (i) => d(i.issue_date) }, { h: 'Period', k: 'period' }, { h: 'Total', num: 1, f: (i) => money(i.total) }, { h: 'Paid', num: 1, f: (i) => money(i.paid) }, { h: 'Status', f: (i) => pill(i.status) }], inv)}</div>
      <div class="card"><h2>Payments</h2>${table([{ h: 'Date', f: (p) => d(p.paid_on) }, { h: 'Amount', num: 1, f: (p) => money(p.amount) }, { h: 'Method', f: (p) => label(p.method) }, { h: 'Reference', k: 'reference' }, { h: 'Kind', k: 'kind' }, { h: 'Reconciled', f: (p) => p.reconciled ? pill('ok', 'Yes') : pill('warn', 'No') }], pays)}</div>`;
    if (tab === 'activity') body = html`<div class="cols"><div class="card"><h2>Lifts</h2>${table([{ h: 'Date', f: (l) => d(l.date) }, { h: 'Slot', k: 'slot' }, { h: '', f: (l) => html`${l.is_extra ? pill('warn', 'Extra $30') : ''} ${pill(l.status === 'booked' ? 'booked_lift' : l.status, label(l.status))}` }], lifts)}</div>
      <div class="card"><h2>Checklists</h2>${table([{ h: 'When', f: (k) => dt(k.created_at) }, { h: 'Type', f: (k) => html`<a href="/admin/checklists/${k.id}">${label(k.type)}</a>` }, { h: 'Boat', k: 'boat' }], checks)}</div></div>`;
    if (tab === 'comms') body = html`<form class="card" method="post" action="/admin/customers/${c.id}/comm"><h2>Log contact</h2><div class="inline-form">${field('channel', 'Channel', { options: ['phone', 'email', 'messenger', 'sms', 'in person'] })}${field('direction', 'Direction', { options: [['out', 'Outbound'], ['in', 'Inbound']] })}<div class="field" style="flex:1;min-width:240px"><label for="sm">Summary</label><input id="sm" name="summary" required></div><button class="btn btn-brand btn-sm">Save</button></div></form>
      <div class="card"><h2>Logged contact</h2>${table([{ h: 'When', f: (x) => dt(x.created_at) }, { h: 'Channel', k: 'channel' }, { h: 'Dir', k: 'direction' }, { h: 'Summary', k: 'summary' }, { h: 'By', k: 'uname' }], comms)}</div>
      <div class="card"><h2>Emails sent</h2>${table([{ h: 'When', f: (x) => dt(x.created_at) }, { h: 'Subject', f: (x) => html`<a href="/admin/outbox/${x.id}">${x.subject}</a>` }], mail)}</div>`;
    if (tab === 'edit') body = html`<form class="card" method="post" action="/admin/customers/${c.id}" style="max-width:760px">${custForm(c)}<button class="btn btn-brand">Save changes</button></form>`;
    await page(req, res, c.name, html`<nav class="tabs">${tabs.map(([k, l]) => html`<a href="?tab=${k}" ${raw(k === tab ? 'aria-current="page"' : '')}>${l}</a>`)}</nav>${body}`,
      { active: '/admin/customers', actions: html`<a class="btn btn-outline btn-sm" href="/admin/bookings/new?customer=${c.id}">New booking</a>` });
  });
  r.post('/customers/:id/comm', async (req, res) => {
    await h.run('INSERT INTO communications (customer_id,channel,direction,summary,user_id) VALUES (?,?,?,?,?)', req.params.id, req.body.channel, req.body.direction, req.body.summary, req.user.id);
    flash(res, 'Contact logged.'); res.redirect(`/admin/customers/${req.params.id}?tab=comms`);
  });

  // ======================= BOATS =======================
  const BOAT_COLS = ['name', 'type', 'make_model', 'length_m', 'hin', 'rego', 'engine', 'trailer', 'trailer_details', 'insurer', 'insurance_policy', 'insurance_expiry'];
  const boatForm = (b = {}) => html`
    <div class="row">${field('name', 'Boat name', { value: b.name, required: true })}${field('type', 'Type', { value: b.type })}</div>
    <div class="row">${field('make_model', 'Make / model', { value: b.make_model })}${field('length_m', 'Length (m)', { type: 'number', value: b.length_m, attrs: 'step="0.1" min="1"', required: true })}</div>
    <div class="row">${field('hin', 'HIN', { value: b.hin })}${field('rego', 'Rego', { value: b.rego })}</div>
    ${field('engine', 'Engine details', { value: b.engine })}
    <div class="row">${field('trailer', 'Trailer', { options: [['0', 'No'], ['1', 'Yes']], value: String(b.trailer ?? 0) })}${field('trailer_details', 'Trailer details / rego', { value: b.trailer_details })}</div>
    <div class="row-3">${field('insurer', 'Insurer', { value: b.insurer })}${field('insurance_policy', 'Policy #', { value: b.insurance_policy })}${field('insurance_expiry', 'Insurance expiry', { type: 'date', value: b.insurance_expiry })}</div>`;

  r.get('/boats', async (req, res) => {
    const q = `%${req.query.q || ''}%`;
    const rows = await h.all(`SELECT bt.*, c.name owner, (SELECT bay.code FROM bookings b JOIN bays bay ON bay.id=b.bay_id WHERE b.boat_id=bt.id AND b.status IN ('confirmed','active') ORDER BY b.start_date DESC LIMIT 1) bay
      FROM boats bt LEFT JOIN customers c ON c.id=bt.customer_id WHERE bt.name LIKE ? OR bt.make_model LIKE ? OR bt.rego LIKE ? OR bt.hin LIKE ? OR c.name LIKE ? ORDER BY bt.name`, q, q, q, q, q);
    await page(req, res, 'Boats', html`<form class="filters"><input type="search" name="q" placeholder="Search boat, rego, HIN, owner" value="${req.query.q || ''}" aria-label="Search"><button class="btn btn-brand btn-sm">Search</button></form>
      <div class="card">${table([{ h: 'Boat', f: (b) => html`<a href="/admin/boats/${b.id}">${b.name}</a>` }, { h: 'Make / model', k: 'make_model' }, { h: 'Length', f: (b) => b.length_m + ' m' }, { h: 'Owner', k: 'owner' }, { h: 'Bay', f: (b) => b.bay || '—' }, { h: 'Rego', k: 'rego' }, { h: 'Insurance', f: (b) => b.insurance_expiry ? html`${d(b.insurance_expiry)} ${b.insurance_expiry < today() ? pill('err', 'Expired') : b.insurance_expiry < C.addDays(today(), 30) ? pill('warn', 'Due') : ''}` : '—' }], rows)}</div>`);
  });
  r.get('/boats/new', async (req, res) => await page(req, res, 'Add boat', html`<form class="card" method="post" action="/admin/boats" style="max-width:760px">
    ${field('customer_id', 'Owner', { options: [['', 'Select…'], ...(await h.all('SELECT id,name FROM customers ORDER BY name')).map((c) => [c.id, c.name])], value: req.query.customer, required: true })}${boatForm()}<button class="btn btn-brand">Save boat</button></form>`, { active: '/admin/boats' }));
  r.post('/boats', async (req, res) => {
    if (!req.body.customer_id || !(Number(req.body.length_m) > 0)) return back(req, res, 'Choose an owner and enter the length.');
    const x = await h.run(`INSERT INTO boats (customer_id,${BOAT_COLS},qr_token) VALUES (?,${BOAT_COLS.map(() => '?')},?)`, req.body.customer_id, ...BOAT_COLS.map((k) => req.body[k] || null), crypto.randomBytes(12).toString('base64url'));
    const id = Number(x.lastInsertRowid);
    await S.audit(h, req.user, 'create', 'boat', id);
    await S.screenWatchlist(h, 'boat', id, { rego: req.body.rego, hin: req.body.hin });
    flash(res, 'Boat saved.'); res.redirect('/admin/boats/' + id);
  });
  r.post('/boats/:id', async (req, res) => {
    await h.run(`UPDATE boats SET ${BOAT_COLS.map((k) => k + '=?')} WHERE id=?`, ...BOAT_COLS.map((k) => req.body[k] || null), req.params.id);
    await S.audit(h, req.user, 'update', 'boat', Number(req.params.id));
    flash(res, 'Boat updated.'); res.redirect('/admin/boats/' + req.params.id);
  });
  r.post('/boats/:id/files', upload.array('files', 10), async (req, res) => {
    const b = await h.get('SELECT * FROM boats WHERE id=?', req.params.id);
    const docs = JSON.parse(b.docs || '[]');
    for (const f of req.files || []) docs.push({ name: f.originalname, path: '/uploads/' + f.filename, at: new Date().toISOString() });
    const photo = req.body.as_photo && req.files?.[0] ? '/uploads/' + req.files[0].filename : b.photo;
    await h.run('UPDATE boats SET docs=?, photo=? WHERE id=?', JSON.stringify(docs), photo, b.id);
    await S.audit(h, req.user, 'upload', 'boat', b.id, { files: (req.files || []).map((f) => f.originalname) });
    flash(res, `${(req.files || []).length} file(s) uploaded.`); res.redirect('/admin/boats/' + b.id);
  });

  const boatData = async (id) => {
    const b = await h.get('SELECT bt.*, c.name owner, c.phone, c.email FROM boats bt LEFT JOIN customers c ON c.id=bt.customer_id WHERE bt.id=?', id);
    if (!b) return null;
    b.booking = await h.get(`SELECT b.*, bay.code, bay.zone FROM bookings b JOIN bays bay ON bay.id=b.bay_id WHERE b.boat_id=? AND b.status IN ('confirmed','active','pending') ORDER BY start_date DESC LIMIT 1`, id);
    b.qrUrl = `${h.setting('base_url')}/q/${b.qr_token}`;
    return b;
  };

  r.get('/boats/:id', async (req, res, next) => {
    const b = await boatData(req.params.id);
    if (!b) return next();
    const qr = await QRCode.toDataURL(b.qrUrl, { margin: 1, width: 360, color: { dark: '#17414E' } });
    const checks = await h.all('SELECT k.*, u.name staff FROM checklists k LEFT JOIN users u ON u.id=k.staff_id WHERE boat_id=? ORDER BY created_at DESC', b.id);
    const lifts = await h.all('SELECT * FROM lifts WHERE boat_id=? ORDER BY date DESC LIMIT 15', b.id);
    const jobs = await h.all('SELECT * FROM service_jobs WHERE boat_id=? ORDER BY created_at DESC', b.id);
    const docs = JSON.parse(b.docs || '[]');
    const out = await h.get(`SELECT * FROM checklists r WHERE r.boat_id=? AND r.type='release' AND NOT EXISTS (SELECT 1 FROM checklists x WHERE x.release_id=r.id) ORDER BY created_at DESC LIMIT 1`, b.id);
    const body = html`
      ${req.query.scan ? html`<div class="alert info">Opened from QR scan. Pick a quick action below.</div>` : ''}
      <div class="card"><h2>Quick actions ${out ? pill('warn', 'Out on the water since ' + dt(out.created_at)) : pill('ok', 'In the yard')}</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn btn-brand" href="/admin/checklists/new?type=checkin&boat=${b.id}">Start check-in</a>
          ${out ? html`<a class="btn btn-primary" href="/admin/checklists/new?type=return&boat=${b.id}">Check in return</a>` : html`<a class="btn btn-primary" href="/admin/checklists/new?type=release&boat=${b.id}">Start release</a>`}
          ${b.booking ? html`<a class="btn btn-outline" href="/admin/lifts?booking=${b.booking.id}">Log / book lift</a>` : ''}
          <a class="btn btn-outline" href="/admin/services/new?boat=${b.id}">Log maintenance</a>
          <a class="btn btn-outline" href="/admin/boats/${b.id}/sheet">Boat info sheet</a>
        </div></div>
      <div class="cols">
        <div class="card"><h2>${b.name}</h2>${b.photo ? html`<img src="${b.photo}" alt="Photo of ${b.name}" style="border-radius:8px;margin-bottom:12px;max-height:240px;object-fit:cover;width:100%">` : ''}
          <dl class="kv"><dt>Owner</dt><dd><a href="/admin/customers/${b.customer_id}">${b.owner}</a> · ${b.phone}</dd><dt>Make / model</dt><dd>${b.make_model}</dd><dt>Type</dt><dd>${b.type}</dd><dt>Length</dt><dd>${b.length_m} m (${C.mToFt(b.length_m)} ft)</dd>
          <dt>HIN</dt><dd>${b.hin || '—'}</dd><dt>Rego</dt><dd>${b.rego || '—'}</dd><dt>Engine</dt><dd>${b.engine || '—'}</dd><dt>Trailer</dt><dd>${b.trailer ? 'Yes · ' + (b.trailer_details || '') : 'No'}</dd>
          <dt>Insurance</dt><dd>${b.insurer || '—'} ${b.insurance_policy || ''} · expires ${d(b.insurance_expiry) || '—'}</dd>
          <dt>Bay</dt><dd>${b.booking ? html`<a href="/admin/bookings/${b.booking.id}">${b.booking.code}</a> · ${label(b.booking.package)} · until ${d(b.booking.end_date)}` : '—'}</dd></dl></div>
        <div class="card" style="text-align:center"><h2>QR code</h2><img class="qr" src="${qr}" alt="QR code for ${b.name}" style="margin:0 auto"><p class="small muted">Scanning opens this record for signed-in staff. Public scans show no personal data.</p></div>
        <form class="card" method="post" action="/admin/boats/${b.id}/files" enctype="multipart/form-data"><h2>Photos &amp; documents</h2>
          ${docs.length ? html`<ul class="small">${docs.map((x) => html`<li><a href="${x.path}" target="_blank">${x.name}</a> <span class="muted">${dt(x.at)}</span></li>`)}</ul>` : html`<p class="small muted">No files yet.</p>`}
          <div class="field"><label for="files">Add files (photos, rego papers, insurance certificate)</label><input id="files" type="file" name="files" multiple accept="image/*,application/pdf" capture="environment"></div>
          <label class="check small"><input type="checkbox" name="as_photo" value="1"> Use first file as the boat’s main photo</label>
          <button class="btn btn-brand btn-sm" style="margin-top:10px">Upload</button></form>
      </div>
      <div class="card"><h2>Checklists &amp; releases</h2>${table([{ h: 'When', f: (k) => dt(k.created_at) }, { h: 'Type', f: (k) => html`<a href="/admin/checklists/${k.id}">${label(k.type)}</a>` }, { h: 'Staff', k: 'staff' }, { h: 'Released to', k: 'released_to' }, { h: 'Fuel', k: 'fuel_level' }], checks)}</div>
      <div class="cols"><div class="card"><h2>Lifts</h2>${table([{ h: 'Date', f: (l) => d(l.date) }, { h: 'Slot', k: 'slot' }, { h: '', f: (l) => html`${l.is_extra ? pill('warn', 'Extra') : ''} ${pill(l.status === 'booked' ? 'booked_lift' : l.status, label(l.status))}` }], lifts)}</div>
      <div class="card"><h2>Service jobs</h2>${table([{ h: 'Job', f: (j) => html`<a href="/admin/services/${j.id}">${label(j.service)}: ${j.description}</a>` }, { h: 'Status', f: (j) => pill(j.status) }], jobs)}</div></div>
      <details class="card"><summary><b>Edit boat details</b></summary><form method="post" action="/admin/boats/${b.id}" style="margin-top:14px">${boatForm(b)}<button class="btn btn-brand">Save</button></form></details>`;
    await page(req, res, b.name, body, { active: '/admin/boats' });
  });

  // Printable "birth certificate"
  r.get('/boats/:id/sheet', async (req, res, next) => {
    const b = await boatData(req.params.id);
    if (!b) return next();
    const qr = await QRCode.toDataURL(b.qrUrl, { margin: 1, width: 400, color: { dark: '#17414E' } });
    const biz = res.locals.biz;
    await page(req, res, 'Boat info sheet', html`
      <div class="no-print" style="margin-bottom:12px"><button class="btn btn-brand btn-sm" onclick="window.print()">Print / save PDF</button></div>
      <div class="card" style="max-width:820px">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:20px;border-bottom:3px solid var(--brand);padding-bottom:14px;margin-bottom:18px">
          <div><img src="/static/img/logo-240.png" alt="Cockatoo Marine" style="height:70px;width:auto"></div>
          <div style="text-align:right"><div style="font-size:1.6rem;font-weight:700;color:var(--brand)">Boat info sheet</div><div class="muted small">Issued ${d(today())}</div></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 220px;gap:24px">
          <div><h2 style="font-size:1.8rem;margin-bottom:4px">${b.name}</h2><p class="muted">${b.make_model} · ${b.type}</p>
            ${b.photo ? html`<img src="${b.photo}" alt="" style="border-radius:8px;max-height:220px;object-fit:cover;width:100%;margin-bottom:14px">` : ''}
            <dl class="kv"><dt>Length</dt><dd>${b.length_m} m (${C.mToFt(b.length_m)} ft)</dd><dt>HIN</dt><dd>${b.hin || '—'}</dd><dt>Rego</dt><dd>${b.rego || '—'}</dd><dt>Engine</dt><dd>${b.engine || '—'}</dd>
            <dt>Trailer</dt><dd>${b.trailer ? b.trailer_details || 'Yes' : 'No'}</dd><dt>Owner</dt><dd>${b.owner}</dd><dt>Contact</dt><dd>${b.phone}</dd>
            <dt>Assigned bay</dt><dd><b>${b.booking ? `${b.booking.code} · ${b.booking.zone}` : 'Not assigned'}</b></dd><dt>Package</dt><dd>${b.booking ? `${label(b.booking.package)} · ${label(b.booking.term)}` : '—'}</dd>
            <dt>Insurance</dt><dd>${b.insurer || '—'} · exp. ${d(b.insurance_expiry) || '—'}</dd></dl></div>
          <div style="text-align:center"><img src="${qr}" alt="QR code" style="width:200px;height:200px;margin:0 auto"><p class="small muted">Scan to open this boat’s record (staff sign-in required)</p></div>
        </div>
        <p class="small muted" style="margin-top:18px;border-top:1px solid var(--border);padding-top:10px">${biz.name} · ABN ${biz.abn} · ${biz.address} · ${biz.phone}</p>
      </div>`, { active: '/admin/boats' });
  });

  // ======================= CHECKLISTS =======================
  r.get('/checklists', async (req, res) => {
    const rows = await h.all('SELECT k.*, bt.name boat, u.name staff, c.name cname FROM checklists k JOIN boats bt ON bt.id=k.boat_id LEFT JOIN users u ON u.id=k.staff_id LEFT JOIN customers c ON c.id=k.customer_id ORDER BY k.created_at DESC LIMIT 200');
    await page(req, res, 'Checklists', html`<div class="card">${table([{ h: 'When', f: (k) => html`<a href="/admin/checklists/${k.id}">${dt(k.created_at)}</a>` }, { h: 'Type', f: (k) => pill(k.type === 'release' ? 'warn' : k.type === 'return' ? 'info' : 'ok', label(k.type)) }, { h: 'Boat', k: 'boat' }, { h: 'Customer', k: 'cname' }, { h: 'Staff', k: 'staff' }, { h: 'Fails', num: 1, f: (k) => Object.values(JSON.parse(k.results || '{}')).filter((v) => v.status === 'fail').length || '—' }], rows)}</div>`,
      { actions: html`<a class="btn btn-brand btn-sm" href="/admin/checklists/new">New checklist</a><a class="btn btn-outline btn-sm" href="/admin/checklists/templates">Templates</a>` });
  });

  r.get('/checklists/new', async (req, res) => {
    const type = ['checkin', 'release', 'return'].includes(req.query.type) ? req.query.type : null;
    const boat = req.query.boat ? await h.get('SELECT bt.*, c.name owner FROM boats bt LEFT JOIN customers c ON c.id=bt.customer_id WHERE bt.id=?', req.query.boat) : null;
    if (!type || !boat) {
      return await page(req, res, 'New checklist', html`<form class="card" method="get" style="max-width:560px">
        ${field('type', 'Checklist', { options: [['checkin', 'Receiving / check-in'], ['release', 'Release (boat going out)'], ['return', 'Return (boat coming back)']], value: type })}
        ${field('boat', 'Boat', { options: (await h.all('SELECT bt.id, bt.name, c.name owner FROM boats bt LEFT JOIN customers c ON c.id=bt.customer_id ORDER BY bt.name')).map((b) => [b.id, `${b.name} (${b.owner})`]) })}
        <button class="btn btn-brand btn-block">Start</button></form>`, { active: '/admin/checklists' });
    }
    const tpl = await h.get('SELECT * FROM checklist_templates WHERE type=? AND active=1 ORDER BY id DESC', type);
    const items = JSON.parse(tpl.items);
    const release = type === 'return' ? await h.get(`SELECT * FROM checklists r WHERE boat_id=? AND type='release' AND NOT EXISTS (SELECT 1 FROM checklists x WHERE x.release_id=r.id) ORDER BY created_at DESC`, boat.id) : null;
    const last = await h.get('SELECT inventory FROM checklists WHERE boat_id=? ORDER BY created_at DESC', boat.id);
    const sections = [...new Set(items.map((i) => i.section))];
    const body = html`<form method="post" action="/admin/checklists" enctype="multipart/form-data" style="max-width:760px">
      <input type="hidden" name="type" value="${type}"><input type="hidden" name="boat_id" value="${boat.id}"><input type="hidden" name="template_id" value="${tpl.id}"><input type="hidden" name="release_id" value="${release?.id || ''}">
      <div class="card"><h2>${tpl.name}: ${boat.name}</h2><p class="muted small">${boat.make_model} · ${boat.length_m} m · owner ${boat.owner} · ${dt(new Date().toISOString())} · staff ${req.user.name}</p>
        ${type === 'return' && !release ? html`<div class="alert warn">No open release found for this boat. The return will be saved without a comparison.</div>` : ''}
        ${release ? html`<div class="alert info">Comparing against the release on ${dt(release.created_at)} to ${release.released_to}.</div>` : ''}</div>
      ${sections.map((s) => html`<div class="card"><h2>${s}</h2>${items.map((it, i) => it.section !== s ? '' : html`<div class="ck-item">
        <div class="top"><span><b>${it.label}</b> ${it.required ? '' : html`<span class="muted small">(optional)</span>`} ${it.photo ? pill('info', 'Photo') : ''}</span>
          <div class="tri" role="radiogroup" aria-label="${it.label}">
            <input type="radio" id="i${i}p" name="r_${i}" value="pass" ${raw(it.required ? 'required' : '')}><label class="p" for="i${i}p">Pass</label>
            <input type="radio" id="i${i}f" name="r_${i}" value="fail"><label class="f" for="i${i}f">Fail</label>
            <input type="radio" id="i${i}n" name="r_${i}" value="na"><label class="n" for="i${i}n">N/A</label></div></div>
        <input type="text" name="n_${i}" placeholder="Note (optional)" aria-label="Note for ${it.label}">
        ${it.photo ? html`<input type="file" name="photos" accept="image/*" capture="environment" aria-label="Photo for ${it.label}" style="margin-top:8px">` : ''}</div>`)}</div>`)}
      <div class="card"><h2>Condition &amp; inventory</h2>
        ${field('inventory', 'Inventory of items on the vessel', { type: 'textarea', value: last?.inventory || '', hint: 'Prefilled from the last checklist. Update anything that has changed.' })}
        ${field('fuel_level', 'Fuel level (as observed)', { options: ['Empty', '1/4', '1/2', '3/4', 'Full', 'Not checked'] })}
        ${field('damage_notes', 'Existing damage', { type: 'textarea' })}
        <div class="field"><label for="ph">Damage / general photos</label><input id="ph" type="file" name="photos" accept="image/*" capture="environment" multiple></div>
        ${type === 'release' ? field('released_to', 'Released to (name of person taking the boat)', { value: boat.owner, required: true }) : ''}</div>
      <div class="card"><h2>Customer signature</h2>
        ${field('signed_name', 'Customer name', { value: boat.owner, required: true })}
        <canvas class="sig" id="sigpad" data-target="signature" aria-label="Signature pad"></canvas><input type="hidden" name="signature" id="signature">
        <div style="display:flex;justify-content:space-between;margin-top:8px"><button type="button" class="btn btn-outline btn-sm" data-clear="sigpad">Clear</button><span class="small muted">Sign with a finger or stylus</span></div>
        <label class="check" style="margin-top:14px"><input type="checkbox" name="email_customer" value="1" checked> Email a copy to the customer</label></div>
      <button class="btn btn-primary btn-block">Complete ${label(type)}</button></form>`;
    await page(req, res, label(type) + ' checklist', body, { active: '/admin/checklists' });
  });

  r.post('/checklists', upload.array('photos', 12), async (req, res) => {
    const b = req.body;
    const boat = await h.get('SELECT * FROM boats WHERE id=?', b.boat_id);
    const tpl = await h.get('SELECT * FROM checklist_templates WHERE id=?', b.template_id);
    if (!boat || !tpl) return back(req, res, 'Boat or template missing.');
    const items = JSON.parse(tpl.items);
    const results = {};
    for (const [i, it] of items.entries()) {
      const st = b['r_' + i];
      if (it.required && !st) return back(req, res, `Answer “${it.label}”.`);
      results[it.label] = { status: st || 'na', note: b['n_' + i] || '' };
    }
    if (!b.signature) return back(req, res, 'The customer needs to sign.');
    if (b.type === 'release' && !b.released_to) return back(req, res, 'Enter who the boat was released to.');
    const booking = await h.get(`SELECT id FROM bookings WHERE boat_id=? AND status IN ('confirmed','active') ORDER BY start_date DESC`, boat.id);
    const photos = (req.files || []).map((f) => '/uploads/' + f.filename);
    const x = await h.run(`INSERT INTO checklists (type,template_id,boat_id,booking_id,customer_id,staff_id,results,inventory,fuel_level,damage_notes,photos,signature,signed_name,released_to,release_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      b.type, tpl.id, boat.id, booking?.id ?? null, boat.customer_id, req.user.id, JSON.stringify(results), b.inventory, b.fuel_level, b.damage_notes, JSON.stringify(photos), b.signature, b.signed_name, b.released_to || null, b.release_id || null);
    const id = Number(x.lastInsertRowid);
    await S.audit(h, req.user, 'create', 'checklist', id, { type: b.type, boat: boat.name, released_to: b.released_to });
    if (b.type === 'checkin' && booking) await h.run(`UPDATE bookings SET status='active' WHERE id=? AND status='confirmed'`, booking.id);
    if (b.email_customer) {
      const cust = await h.get('SELECT * FROM customers WHERE id=?', boat.customer_id);
      if (cust?.email) await S.notify(h, { to: cust.email, customerId: cust.id, subject: `${label(b.type)} report for ${boat.name}`, body: `Hi ${cust.name},\n\nYour ${label(b.type).toLowerCase()} report for ${boat.name} is ready: ${h.setting('base_url')}/portal/checklists/${id}\n\nCockatoo Marine` });
    }
    flash(res, `${label(b.type)} saved.`); res.redirect('/admin/checklists/' + id);
  });

  r.get('/checklists/:id', async (req, res, next) => {
    const body = await renderChecklist(h, req.params.id);
    if (!body) return next();
    await page(req, res, 'Checklist report', html`<div class="no-print" style="margin-bottom:12px"><button class="btn btn-brand btn-sm" onclick="window.print()">Print / save PDF</button></div>${body}`, { active: '/admin/checklists' });
  });

  r.get('/checklists/templates', (req, res) => { res.redirect('/admin/settings?tab=checklists'); });

  // ======================= RELEASE LOG =======================
  r.get('/releases', async (req, res) => {
    const rows = await h.all(`SELECT r.*, bt.name boat, u.name staff, ret.created_at returned_at, ret.id ret_id, ru.name ret_staff FROM checklists r JOIN boats bt ON bt.id=r.boat_id LEFT JOIN users u ON u.id=r.staff_id
      LEFT JOIN checklists ret ON ret.release_id=r.id LEFT JOIN users ru ON ru.id=ret.staff_id WHERE r.type='release' ORDER BY r.created_at DESC`);
    for (const x of rows) x.diffs = x.ret_id ? await diffCount(h, x.id, x.ret_id) : null;
    await page(req, res, 'Release log', html`<p class="muted">Who took each boat out, who released it, and when it came back.</p><div class="card">${table([
      { h: 'Boat', f: (x) => html`<a href="/admin/boats/${x.boat_id}">${x.boat}</a>` }, { h: 'Released', f: (x) => html`<a href="/admin/checklists/${x.id}">${dt(x.created_at)}</a>` },
      { h: 'Released to', k: 'released_to' }, { h: 'Released by', k: 'staff' },
      { h: 'Returned', f: (x) => x.returned_at ? html`<a href="/admin/checklists/${x.ret_id}">${dt(x.returned_at)}</a>` : pill('warn', 'Still out') }, { h: 'Received by', k: 'ret_staff' },
      { h: 'Differences', f: (x) => { if (!x.ret_id) return ''; const n = x.diffs; return n ? pill('err', `${n} flagged`) : pill('ok', 'None'); } },
    ], rows)}</div>`);
  });
};

async function diff(h, relId, retId) {
  const a = await h.get('SELECT * FROM checklists WHERE id=?', relId), b = await h.get('SELECT * FROM checklists WHERE id=?', retId);
  const ra = JSON.parse(a.results), rb = JSON.parse(b.results);
  const items = Object.keys(rb).filter((k) => ra[k] && ra[k].status !== rb[k].status).map((k) => ({ item: k, out: ra[k].status, back: rb[k].status }));
  if ((a.fuel_level || '') !== (b.fuel_level || '')) items.push({ item: 'Fuel level', out: a.fuel_level, back: b.fuel_level });
  if ((a.inventory || '').trim() !== (b.inventory || '').trim()) items.push({ item: 'Inventory', out: a.inventory, back: b.inventory });
  return items;
}
const diffCount = async (h, a, b) => (await diff(h, a, b)).filter((x) => x.item !== 'Fuel level').length;

async function renderChecklist(h, id) {
  const k = await h.get('SELECT k.*, bt.name boat, bt.make_model, bt.length_m, c.name cname, u.name staff, t.name tname FROM checklists k JOIN boats bt ON bt.id=k.boat_id LEFT JOIN customers c ON c.id=k.customer_id LEFT JOIN users u ON u.id=k.staff_id LEFT JOIN checklist_templates t ON t.id=k.template_id WHERE k.id=?', id);
  if (!k) return null;
  const results = JSON.parse(k.results || '{}');
  const photos = JSON.parse(k.photos || '[]');
  const ret = k.type === 'release' ? await h.get('SELECT id FROM checklists WHERE release_id=?', k.id) : null;
  const cmp = k.type === 'return' && k.release_id ? await diff(h, k.release_id, k.id) : (ret ? await diff(h, k.id, ret.id) : null);
  return html`<div class="card" style="max-width:860px">
    <div style="display:flex;justify-content:space-between;gap:16px;border-bottom:3px solid var(--brand);padding-bottom:12px;margin-bottom:14px">
      <img src="/static/img/logo-240.png" alt="Cockatoo Marine" style="height:60px;width:auto">
      <div style="text-align:right"><div style="font-size:1.3rem;font-weight:700;color:var(--brand)">${k.tname || label(k.type)} report</div><div class="small muted">#${k.id} · ${dt(k.created_at)}</div></div></div>
    <dl class="kv"><dt>Boat</dt><dd>${k.boat} · ${k.make_model} · ${k.length_m} m</dd><dt>Customer</dt><dd>${k.cname}</dd><dt>Staff</dt><dd>${k.staff}</dd>
      ${k.released_to ? html`<dt>Released to</dt><dd><b>${k.released_to}</b></dd>` : ''}<dt>Fuel (observed)</dt><dd>${k.fuel_level}</dd><dt>Inventory</dt><dd>${k.inventory || '—'}</dd><dt>Existing damage</dt><dd>${k.damage_notes || '—'}</dd></dl>
    ${cmp ? html`<h3 style="margin-top:18px">Release vs return comparison</h3>${cmp.length ? html`<table class="tbl"><thead><tr><th>Item</th><th>At release</th><th>At return</th></tr></thead><tbody>${cmp.map((x) => html`<tr class="diff"><td>${x.item}</td><td>${x.out}</td><td>${x.back}</td></tr>`)}</tbody></table>` : html`<div class="alert ok">No differences between release and return.</div>`}` : ''}
    <h3 style="margin-top:18px">Checklist</h3>
    <table class="tbl"><thead><tr><th>Item</th><th>Result</th><th>Note</th></tr></thead><tbody>${Object.entries(results).map(([l, v]) => html`<tr><td>${l}</td><td>${pill(v.status, v.status === 'na' ? 'N/A' : label(v.status))}</td><td>${v.note}</td></tr>`)}</tbody></table>
    ${photos.length ? html`<h3 style="margin-top:18px">Photos</h3><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px">${photos.map((p) => html`<a href="${p}" target="_blank"><img src="${p}" alt="Checklist photo" style="border-radius:6px;aspect-ratio:4/3;object-fit:cover;width:100%"></a>`)}</div>` : ''}
    <h3 style="margin-top:18px">Customer signature</h3>
    ${k.signature ? html`<img src="${k.signature}" alt="Signature of ${k.signed_name}" style="max-width:320px;border-bottom:1px solid var(--border)">` : html`<p class="muted">Signed on paper (imported record)</p>`}<p class="small">${k.signed_name}</p>
  </div>`;
}
module.exports.renderChecklist = renderChecklist;
