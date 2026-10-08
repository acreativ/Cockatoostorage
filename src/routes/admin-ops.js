// Lifts, service jobs (antifoul/maintenance) and facility maintenance.
const C = require('../core');
const S = require('../services');
const { html, raw, pill, table, field, money, d, dt, label } = require('../ui');

module.exports = (r, h, { page, back, flash, can, today, upload }) => {
  // ======================= LIFTS =======================
  const activeBookings = async () => await h.all(`SELECT b.id, b.ref, b.package, bt.name boat, c.name cname FROM bookings b JOIN boats bt ON bt.id=b.boat_id JOIN customers c ON c.id=b.customer_id WHERE b.status IN ('confirmed','active') AND b.kind='storage' ORDER BY bt.name`);
  r.get('/lifts', async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today();
    const slots = await S.liftSlots(h, date);
    const lifts = await h.all(`SELECT l.*, bt.name boat, c.name cname, b.package FROM lifts l LEFT JOIN bookings b ON b.id=l.booking_id LEFT JOIN boats bt ON bt.id=l.boat_id LEFT JOIN customers c ON c.id=b.customer_id WHERE l.date=? ORDER BY slot`, date);
    const month = date.slice(0, 7);
    const usage = await h.all(`SELECT b.id, b.ref, b.package, bt.name boat, (SELECT COUNT(*) FROM lifts l WHERE l.booking_id=b.id AND substr(l.date,1,7)=? AND l.status<>'cancelled') used FROM bookings b JOIN boats bt ON bt.id=b.boat_id WHERE b.status IN ('confirmed','active') AND b.kind='storage' ORDER BY used DESC`, month);
    const body = html`
      <form class="filters"><div class="field"><label for="date">Date</label><input type="date" id="date" name="date" value="${date}"></div><button class="btn btn-brand btn-sm">Show</button>
        <a class="btn btn-outline btn-sm" href="?date=${C.addDays(date, -1)}">Previous day</a><a class="btn btn-outline btn-sm" href="?date=${C.addDays(date, 1)}">Next day</a></form>
      <div class="cols">
        <div class="card"><h2>Slots on ${d(date)}</h2>${slots.length ? html`<div class="slot-grid">${slots.map((s) => html`<div class="slot ${s.free <= 0 ? 'full' : ''}"><b>${s.slot}</b><br><span class="small ${s.free <= 0 ? 'muted' : ''}">${s.free <= 0 ? 'Full' : `${s.free} of ${s.cap} free`}</span>
          ${lifts.filter((l) => l.slot === s.slot && l.status !== 'cancelled').map((l) => html`<div class="small" style="margin-top:4px">${l.boat}${l.is_extra ? ' · extra' : ''}${l.engine_flush ? ' · flush' : ''}</div>`)}</div>`)}</div>` : html`<div class="alert warn">Blackout day. No lifts.</div>`}</div>
        <form class="card" method="post" action="/admin/lifts"><h2>Book a lift</h2>
          ${field('booking_id', 'Boat / booking', { options: (await activeBookings()).map((b) => [b.id, `${b.boat} – ${b.cname} (${b.package})`]), value: req.query.booking })}
          <div class="row">${field('date', 'Date', { type: 'date', value: date })}${field('slot', 'Slot', { options: slots.filter((s) => s.free > 0).map((s) => s.slot) })}</div>
          <label class="check small"><input type="checkbox" name="engine_flush" value="1"> Engine flush (Unlimited only)</label>
          ${field('notes', 'Notes')}<button class="btn btn-brand">Book lift</button>
          <p class="small muted" style="margin-top:8px">Standard includes 2 lifts a month. Further lifts are logged as $${C.EXTRA_LIFT_FEE} extras and invoiced in arrears.</p></form>
      </div>
      <div class="card"><h2>Lifts on ${d(date)}</h2>${table([{ h: 'Slot', k: 'slot' }, { h: 'Boat', k: 'boat' }, { h: 'Customer', k: 'cname' }, { h: 'Package', f: (l) => label(l.package) }, { h: 'Via', k: 'booked_via' },
        { h: 'Flags', f: (l) => html`${l.is_extra ? pill('warn', 'Extra $30') : ''} ${l.engine_flush ? pill('info', 'Flush') : ''} ${l.transfer ? pill('muted', 'Transfer') : ''} ${l.wash ? pill('muted', 'Wash') : ''}` },
        { h: 'Status', f: (l) => pill(l.status === 'booked' ? 'booked_lift' : l.status, label(l.status)) },
        { h: '', f: (l) => l.status === 'booked' ? html`<form method="post" action="/admin/lifts/${l.id}" class="inline-form"><button name="status" value="done" class="btn btn-brand btn-sm">Done</button><button name="status" value="no_show" class="btn btn-outline btn-sm">No-show</button><button name="status" value="cancelled" class="btn btn-outline btn-sm">Cancel</button></form>` : '' }], lifts, 'No lifts this day.')}</div>
      <div class="card"><h2>Package usage – ${month}</h2>${table([{ h: 'Boat', k: 'boat' }, { h: 'Booking', f: (b) => html`<a href="/admin/bookings/${b.id}">${b.ref}</a>` }, { h: 'Package', f: (b) => label(b.package) },
        { h: 'Lifts used', f: (b) => b.package === 'standard' ? html`<div style="display:flex;gap:8px;align-items:center"><div class="bar-h" style="width:90px"><span style="width:${Math.min(100, (b.used / 2) * 100)}%"></span></div> ${b.used} / 2 ${b.used > 2 ? pill('warn', `${b.used - 2} extra`) : ''}</div>` : `${b.used} (unlimited)` }], usage)}</div>`;
    await page(req, res, 'Lifts & launches', body);
  });
  r.post('/lifts', async (req, res) => {
    try {
      const x = await S.bookLift(h, { booking_id: Number(req.body.booking_id), date: req.body.date, slot: req.body.slot, engine_flush: !!req.body.engine_flush, notes: req.body.notes, via: 'staff' }, req.user);
      flash(res, x.extra ? 'Lift booked. This is an extra lift ($30, invoiced next month).' : 'Lift booked.');
    } catch (e) { flash(res, '!' + e.message); }
    res.redirect('/admin/lifts?date=' + req.body.date);
  });
  r.post('/lifts/:id', async (req, res) => {
    const l = await h.get('SELECT * FROM lifts WHERE id=?', req.params.id);
    const st = ['done', 'no_show', 'cancelled'].includes(req.body.status) ? req.body.status : 'done';
    await h.run('UPDATE lifts SET status=? WHERE id=?', st, l.id);
    if (st === 'cancelled' && l.is_extra) await h.run(`DELETE FROM extras WHERE source_type='lift' AND source_id=? AND invoice_id IS NULL`, l.id);
    await S.audit(h, req.user, 'update', 'lift', l.id, { status: st });
    flash(res, 'Lift updated.'); res.redirect('/admin/lifts?date=' + l.date);
  });

  // ======================= SERVICE JOBS =======================
  r.get('/services', async (req, res) => {
    const rows = await h.all(`SELECT j.*, c.name cname, bt.name boat, u.name staff FROM service_jobs j LEFT JOIN customers c ON c.id=j.customer_id LEFT JOIN boats bt ON bt.id=j.boat_id LEFT JOIN users u ON u.id=j.assigned_to ORDER BY COALESCE(j.scheduled_date, j.created_at) DESC`);
    await page(req, res, 'Service jobs', html`<div class="card">${table([{ h: 'Job', f: (j) => html`<a href="/admin/services/${j.id}">${label(j.service)}</a>` }, { h: 'Description', k: 'description' }, { h: 'Boat', k: 'boat' }, { h: 'Customer', k: 'cname' }, { h: 'Scheduled', f: (j) => d(j.scheduled_date) }, { h: 'Assigned', k: 'staff' }, { h: 'Quote', num: 1, f: (j) => money(j.quote_amount) }, { h: 'Status', f: (j) => pill(j.status) }], rows)}</div>`,
      { actions: html`<a class="btn btn-brand btn-sm" href="/admin/services/new">New job</a>` });
  });
  const staffOpts = async () => [['', 'Unassigned'], ...(await h.all(`SELECT id,name FROM users WHERE role<>'customer'`)).map((u) => [u.id, u.name])];
  r.get('/services/new', async (req, res) => {
    const boat = req.query.boat ? await h.get('SELECT * FROM boats WHERE id=?', req.query.boat) : null;
    await page(req, res, 'New service job', html`<form class="card" method="post" action="/admin/services" style="max-width:720px">
      ${field('boat_id', 'Boat', { options: (await h.all('SELECT bt.id, bt.name, c.name o FROM boats bt LEFT JOIN customers c ON c.id=bt.customer_id ORDER BY bt.name')).map((b) => [b.id, `${b.name} (${b.o})`]), value: boat?.id })}
      <div class="row">${field('service', 'Service', { options: ['antifoul', 'maintenance', 'transfer', 'wash_down', 'engine_flush'] })}${field('scheduled_date', 'Scheduled date', { type: 'date' })}</div>
      ${field('description', 'Work description', { type: 'textarea', required: true })}
      <div class="row">${field('quote_amount', 'Quote (incl. GST)', { type: 'number', attrs: 'step="0.01"' })}${field('assigned_to', 'Assign to', { options: await staffOpts() })}</div>
      <button class="btn btn-brand">Create job</button></form>`, { active: '/admin/services' });
  });
  r.post('/services', async (req, res) => {
    const b = req.body;
    const boat = await h.get('SELECT * FROM boats WHERE id=?', b.boat_id);
    if (!boat || !b.description) return back(req, res, 'Choose a boat and describe the work.');
    const x = await h.run(`INSERT INTO service_jobs (customer_id,boat_id,service,description,quote_amount,scheduled_date,assigned_to,status) VALUES (?,?,?,?,?,?,?,?)`,
      boat.customer_id, boat.id, b.service, b.description, Number(b.quote_amount) || null, b.scheduled_date || null, b.assigned_to || null, b.scheduled_date ? 'scheduled' : 'quoted');
    await S.audit(h, req.user, 'create', 'service_job', Number(x.lastInsertRowid));
    flash(res, 'Job created.'); res.redirect('/admin/services/' + x.lastInsertRowid);
  });
  r.get('/services/:id', async (req, res, next) => {
    const j = await h.get('SELECT j.*, c.name cname, bt.name boat FROM service_jobs j LEFT JOIN customers c ON c.id=j.customer_id LEFT JOIN boats bt ON bt.id=j.boat_id WHERE j.id=?', req.params.id);
    if (!j) return next();
    const photos = JSON.parse(j.photos || '[]');
    const labour = C.round2(j.labour_hours * j.labour_rate), total = C.round2(labour + (j.parts_cost || 0));
    await page(req, res, `${label(j.service)} job #${j.id}`, html`<div class="cols">
      <div class="card"><h2>${j.boat} ${pill(j.status)}</h2><dl class="kv"><dt>Customer</dt><dd><a href="/admin/customers/${j.customer_id}">${j.cname}</a></dd><dt>Work</dt><dd>${j.description}</dd><dt>Quote</dt><dd>${money(j.quote_amount)}</dd>
        <dt>Labour</dt><dd>${j.labour_hours} h × ${money(j.labour_rate)} = ${money(labour)}</dd><dt>Parts</dt><dd>${j.parts || '—'} (${money(j.parts_cost)})</dd><dt>Actual total</dt><dd><b>${money(total)}</b></dd></dl>
        ${photos.length ? html`<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:12px">${photos.map((p) => html`<img src="${p}" alt="Job photo" style="border-radius:6px;aspect-ratio:1;object-fit:cover">`)}</div>` : ''}
        ${['done'].includes(j.status) && can(req.user, 'admin', 'office') ? html`<form method="post" action="/admin/services/${j.id}/invoice" style="margin-top:14px"><button class="btn btn-primary">Create invoice (${money(total || j.quote_amount)})</button></form>` : ''}</div>
      <form class="card" method="post" action="/admin/services/${j.id}" enctype="multipart/form-data"><h2>Update job</h2>
        <div class="row">${field('status', 'Status', { options: ['quoted', 'scheduled', 'in_progress', 'done', 'cancelled'], value: j.status })}${field('scheduled_date', 'Scheduled', { type: 'date', value: j.scheduled_date })}</div>
        ${field('assigned_to', 'Assigned to', { options: await staffOpts(), value: j.assigned_to })}
        ${field('parts', 'Parts used', { value: j.parts })}
        <div class="row-3">${field('parts_cost', 'Parts $', { type: 'number', value: j.parts_cost, attrs: 'step="0.01"' })}${field('labour_hours', 'Labour hours', { type: 'number', value: j.labour_hours, attrs: 'step="0.25"' })}${field('labour_rate', 'Rate $/h', { type: 'number', value: j.labour_rate, attrs: 'step="0.01"' })}</div>
        <div class="field"><label for="ph">Add photos</label><input id="ph" type="file" name="photos" multiple accept="image/*" capture="environment"></div>
        <button class="btn btn-brand">Save</button></form></div>`, { active: '/admin/services' });
  });
  r.post('/services/:id', upload.array('photos', 10), async (req, res) => {
    const j = await h.get('SELECT * FROM service_jobs WHERE id=?', req.params.id);
    const b = req.body;
    const photos = [...JSON.parse(j.photos || '[]'), ...(req.files || []).map((f) => '/uploads/' + f.filename)];
    await h.run('UPDATE service_jobs SET status=?, scheduled_date=?, assigned_to=?, parts=?, parts_cost=?, labour_hours=?, labour_rate=?, photos=? WHERE id=?',
      b.status, b.scheduled_date || null, b.assigned_to || null, b.parts, Number(b.parts_cost) || 0, Number(b.labour_hours) || 0, Number(b.labour_rate) || 0, JSON.stringify(photos), j.id);
    await S.audit(h, req.user, 'update', 'service_job', j.id, { status: b.status });
    flash(res, 'Job updated.'); res.redirect('/admin/services/' + j.id);
  });
  r.post('/services/:id/invoice', async (req, res) => {
    const j = await h.get('SELECT * FROM service_jobs WHERE id=?', req.params.id);
    const labour = C.round2(j.labour_hours * j.labour_rate);
    const lines = [];
    if (labour) lines.push({ description: `${label(j.service)} labour – ${j.labour_hours} h`, category: j.service, billing: 'arrears', qty: j.labour_hours, unit_inc: j.labour_rate, amount_inc: labour });
    if (j.parts_cost) lines.push({ description: `Parts: ${j.parts}`, category: j.service, billing: 'arrears', qty: 1, unit_inc: j.parts_cost, amount_inc: j.parts_cost });
    if (!lines.length) lines.push({ description: `${label(j.service)}: ${j.description}`, category: j.service, billing: 'arrears', qty: 1, unit_inc: j.quote_amount, amount_inc: j.quote_amount });
    const inv = await S.createInvoice(h, { customer_id: j.customer_id, period: 'service', kind: 'service', issue_date: today(), due_date: C.addDays(today(), 14), lines }, req.user);
    await h.run(`UPDATE service_jobs SET status='invoiced' WHERE id=?`, j.id);
    flash(res, `Invoice ${inv.number} created.`); res.redirect('/admin/invoices/' + inv.id);
  });

  // ======================= FACILITY MAINTENANCE =======================
  r.get('/maintenance', async (req, res) => {
    const jobs = await h.all(`SELECT m.*, a.name asset, a.type atype FROM maintenance_jobs m JOIN assets a ON a.id=m.asset_id ORDER BY m.status='done', m.due_date`);
    const assets = await h.all('SELECT a.*, (SELECT MAX(completed_at) FROM maintenance_jobs m WHERE m.asset_id=a.id) last FROM assets a ORDER BY type, name');
    await page(req, res, 'Maintenance', html`
      <div class="card"><h2>Jobs</h2>${table([{ h: 'Asset', k: 'asset' }, { h: 'Job', f: (m) => html`<a href="/admin/maintenance/${m.id}">${m.title}</a>` }, { h: 'Kind', f: (m) => html`${label(m.kind)}${m.recur_days ? html` <span class="small muted">every ${m.recur_days}d</span>` : ''}` },
        { h: 'Due', f: (m) => html`${d(m.due_date)} ${m.status !== 'done' && m.due_date < today() ? pill('overdue', 'Overdue') : ''}` }, { h: 'Status', f: (m) => pill(m.status) }, { h: 'Blocks bay', f: (m) => m.block_booking_id ? pill('muted', 'Yes') : '' }], jobs)}</div>
      <div class="card"><h2>Assets</h2>${table([{ h: 'Asset', k: 'name' }, { h: 'Type', f: (a) => label(a.type) }, { h: 'Last serviced', f: (a) => dt(a.last) || '—' }], assets)}
        <form method="post" action="/admin/maintenance/assets" class="inline-form" style="margin-top:12px">${field('name', 'New asset', { required: true })}${field('type', 'Type', { options: ['equipment', 'facility', 'bay'] })}<button class="btn btn-outline btn-sm">Add asset</button></form></div>`,
      { actions: html`<a class="btn btn-brand btn-sm" href="/admin/maintenance/new">New job</a>` });
  });
  r.post('/maintenance/assets', async (req, res) => { await h.run('INSERT INTO assets (name,type) VALUES (?,?)', req.body.name, req.body.type); flash(res, 'Asset added.'); res.redirect('/admin/maintenance'); });
  r.get('/maintenance/new', async (req, res) => await page(req, res, 'New maintenance job', html`<form class="card" method="post" action="/admin/maintenance" style="max-width:720px">
    ${field('asset_id', 'Asset (for a bay, choose “Bay” and pick the bay below)', { options: (await h.all('SELECT id,name FROM assets ORDER BY name')).map((a) => [a.id, a.name]) })}
    ${field('title', 'Job', { required: true })}
    <div class="row">${field('kind', 'Kind', { options: ['reactive', 'scheduled'] })}${field('recur_days', 'Repeat every (days, scheduled only)', { type: 'number' })}</div>
    ${field('due_date', 'Due date', { type: 'date', value: today(), required: true })}
    <fieldset class="card" style="background:var(--surface-2)"><legend class="label">Block a storage bay on the calendar (optional)</legend>
      ${field('bay_id', 'Bay', { options: [['', 'No bay block'], ...(await h.all('SELECT id,code FROM bays ORDER BY code')).map((b) => [b.id, b.code])] })}
      <div class="row">${field('block_start', 'From', { type: 'date' })}${field('block_end', 'Until (exclusive)', { type: 'date' })}</div></fieldset>
    ${field('notes', 'Notes', { type: 'textarea' })}<button class="btn btn-brand">Create job</button></form>`, { active: '/admin/maintenance' }));
  r.post('/maintenance', async (req, res) => {
    const b = req.body;
    try {
      const id = await h.tx(async () => {
        let block = null;
        if (b.bay_id) {
          if (!b.block_start || !b.block_end || b.block_end <= b.block_start) throw new Error('Give a valid date range for the bay block.');
          block = (await S.createBooking(h, { kind: 'maintenance', bay_id: Number(b.bay_id), start_date: b.block_start, end_date: b.block_end, status: 'maintenance', notes: b.title }, req.user)).id;
        }
        const x = await h.run('INSERT INTO maintenance_jobs (asset_id,title,kind,due_date,recur_days,notes,block_booking_id) VALUES (?,?,?,?,?,?,?)', b.asset_id, b.title, b.kind, b.due_date, Number(b.recur_days) || null, b.notes, block);
        await S.audit(h, req.user, 'create', 'maintenance_job', Number(x.lastInsertRowid));
        return Number(x.lastInsertRowid);
      });
      flash(res, 'Maintenance job created.'); res.redirect('/admin/maintenance/' + id);
    } catch (e) { back(req, res, e.message.includes('bay') ? e.message : 'That bay has bookings in those dates. Move them first, or choose other dates.'); }
  });
  r.get('/maintenance/:id', async (req, res, next) => {
    const m = await h.get('SELECT m.*, a.name asset FROM maintenance_jobs m JOIN assets a ON a.id=m.asset_id WHERE m.id=?', req.params.id);
    if (!m) return next();
    const hist = await h.all(`SELECT * FROM maintenance_jobs WHERE asset_id=? AND id<>? ORDER BY due_date DESC`, m.asset_id, m.id);
    await page(req, res, m.title, html`<div class="cols"><div class="card"><h2>${m.asset} ${pill(m.status)}</h2><dl class="kv"><dt>Kind</dt><dd>${label(m.kind)} ${m.recur_days ? `(every ${m.recur_days} days)` : ''}</dd><dt>Due</dt><dd>${d(m.due_date)}</dd><dt>Notes</dt><dd>${m.notes || '—'}</dd><dt>Cost</dt><dd>${money(m.cost)}</dd><dt>Bay block</dt><dd>${m.block_booking_id ? html`<a href="/admin/bookings/${m.block_booking_id}">View on calendar</a>` : '—'}</dd></dl></div>
      <form class="card" method="post" action="/admin/maintenance/${m.id}"><h2>Update</h2>${field('status', 'Status', { options: ['open', 'in_progress', 'done'], value: m.status })}${field('cost', 'Cost (incl. GST)', { type: 'number', value: m.cost, attrs: 'step="0.01"' })}${field('notes', 'Notes', { type: 'textarea', value: m.notes })}<button class="btn btn-brand">Save</button>
        ${m.recur_days ? html`<p class="small muted">Marking done schedules the next one in ${m.recur_days} days.</p>` : ''}</form></div>
      <div class="card"><h2>History for ${m.asset}</h2>${table([{ h: 'Job', k: 'title' }, { h: 'Due', f: (x) => d(x.due_date) }, { h: 'Done', f: (x) => dt(x.completed_at) }, { h: 'Status', f: (x) => pill(x.status) }], hist)}</div>`, { active: '/admin/maintenance' });
  });
  r.post('/maintenance/:id', async (req, res) => {
    const m = await h.get('SELECT * FROM maintenance_jobs WHERE id=?', req.params.id);
    const done = req.body.status === 'done' && m.status !== 'done';
    await h.run('UPDATE maintenance_jobs SET status=?, cost=?, notes=?, completed_at=? WHERE id=?', req.body.status, Number(req.body.cost) || null, req.body.notes, done ? new Date().toISOString() : m.completed_at, m.id);
    if (done && m.block_booking_id) await S.updateBooking(h, m.block_booking_id, { status: 'completed' }, req.user, 'Maintenance finished');
    if (done && m.recur_days) await h.run('INSERT INTO maintenance_jobs (asset_id,title,kind,due_date,recur_days) VALUES (?,?,?,?,?)', m.asset_id, m.title, 'scheduled', C.addDays(today(), m.recur_days), m.recur_days);
    if (done && req.body.cost) await h.run('INSERT INTO expenses (date,category,supplier,description,amount_inc,gst) VALUES (?,?,?,?,?,?)', today(), 'Repairs', 'Maintenance', m.title, Number(req.body.cost), C.gstOf(Number(req.body.cost)));
    await S.audit(h, req.user, 'update', 'maintenance_job', m.id, { status: req.body.status });
    flash(res, done && m.recur_days ? 'Done. Next service scheduled.' : 'Saved.'); res.redirect('/admin/maintenance/' + m.id);
  });
};
