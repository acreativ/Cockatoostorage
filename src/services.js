// Business operations that touch the database. Each takes `h` (see db.helpers).
const crypto = require('node:crypto');
const C = require('./core');

const ACTIVE = ['hold', 'pending', 'confirmed', 'active', 'maintenance'];

// ---------- Audit ----------
async function audit(h, user, action, entity, entityId, detail, reason) {
  await h.run('INSERT INTO audit_log (user_id,user_name,action,entity,entity_id,reason,detail) VALUES (?,?,?,?,?,?,?)',
    user?.id ?? null, user?.name ?? 'system', action, entity, entityId ?? null, reason ?? null,
    detail ? JSON.stringify(detail) : null);
}

// ---------- Email / SMS outbox ----------
// Phase 1 writes every message to the outbox (visible in admin). A provider (SMTP, Postmark, SMS) can drain it later.
const providers = { email: null, sms: null };
async function notify(h, { channel = 'email', to, template, vars = {}, subject, body, dedupe, customerId }) {
  if (template) {
    const t = await h.get('SELECT * FROM email_templates WHERE key=?', template);
    if (t) { subject = C.render(t.subject, vars); body = C.render(t.body, vars); }
  }
  // ON CONFLICT instead of catching the unique error: in Postgres a failed statement would abort the surrounding transaction.
  const r = await h.run(`INSERT INTO outbox (channel,recipient,subject,body,template,dedupe_key,customer_id) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, channel, to, subject, body, template ?? null, dedupe ?? null, customerId ?? null);
  if (!r.changes) return false; // already sent (dedupe)
  providers[channel]?.send({ to, subject, body });
  return true;
}

// ---------- Rates & quotes ----------
function depositOpts(h) {
  return { depositType: h.setting('deposit_type', 'fixed'), depositValue: Number(h.setting('deposit_value', 250)) };
}
async function getQuote(h, input) {
  return C.quote(await h.all('SELECT * FROM rates'), input, depositOpts(h));
}

// ---------- Availability ----------
function bookingEnd(start, term, months) {
  return C.addMonths(start, term === 'annual' ? 12 : Math.max(3, Number(months) || 3));
}
async function availableBays(h, lengthM, start, end) {
  return await h.all(`
    SELECT * FROM bays bay WHERE max_length_m >= ? AND status NOT IN ('out_of_service')
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.bay_id = bay.id
        AND b.status IN ('hold','pending','confirmed','active','maintenance')
        AND (b.status <> 'hold' OR b.hold_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        AND b.start_date < ? AND ? < b.end_date)
    ORDER BY max_length_m, code`, lengthM, end, start);
}

function newRef() { return 'CM-' + crypto.randomBytes(3).toString('hex').toUpperCase(); }

// Tries each fitting bay; the DB trigger is the final arbiter if two requests race.
async function createBooking(h, b, user) {
  const candidates = b.bay_id ? [{ id: Number(b.bay_id) }] : await availableBays(h, b.lengthM, b.start_date, b.end_date);
  for (const bay of candidates) {
    try {
      // Each attempt runs in its own transaction/savepoint so a DOUBLE_BOOKING on one bay doesn't abort the caller's transaction.
      const r = await h.tx(() => h.run(`INSERT INTO bookings (ref,kind,bay_id,customer_id,boat_id,lead_id,package,term,monthly_rate,start_date,end_date,status,
          hold_expires_at,pending_expires_at,deposit_amount,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        newRef(), b.kind || 'storage', bay.id, b.customer_id ?? null, b.boat_id ?? null, b.lead_id ?? null, b.package ?? null, b.term ?? null,
        b.monthly_rate ?? null, b.start_date, b.end_date, b.status, b.hold_expires_at ?? null, b.pending_expires_at ?? null,
        b.deposit_amount ?? null, b.notes ?? null, user?.id ?? null));
      const id = Number(r.lastInsertRowid);
      await audit(h, user, 'create', 'booking', id, { bay_id: bay.id, status: b.status, start: b.start_date, end: b.end_date });
      return await h.get('SELECT * FROM bookings WHERE id=?', id);
    } catch (e) {
      if (!String(e.message).includes('DOUBLE_BOOKING')) throw e;
      if (b.bay_id) throw new Error('That bay is already booked for those dates.');
    }
  }
  throw new Error('No bay that fits this boat is free for those dates.');
}

async function updateBooking(h, id, changes, user, reason) {
  const before = await h.get('SELECT * FROM bookings WHERE id=?', id);
  const cols = Object.keys(changes);
  try {
    await h.run(`UPDATE bookings SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`, ...cols.map((c) => changes[c]), id);
  } catch (e) {
    if (String(e.message).includes('DOUBLE_BOOKING')) throw new Error('That change would double-book the bay. Pick other dates or another bay.');
    throw e;
  }
  await audit(h, user, 'update', 'booking', id, { before: pick(before, cols), after: changes }, reason);
}
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]));

// ---------- Customers / leads ----------
async function upsertCustomer(h, { name, email, phone, source }, user) {
  const existing = email ? await h.get('SELECT * FROM customers WHERE lower(email)=lower(?)', email) : null;
  if (existing) return existing;
  const r = await h.run('INSERT INTO customers (name,email,phone,source) VALUES (?,?,?,?)', name, email, phone, source || 'website');
  await audit(h, user, 'create', 'customer', Number(r.lastInsertRowid));
  return await h.get('SELECT * FROM customers WHERE id=?', r.lastInsertRowid);
}

async function createLead(h, lead, user) {
  const r = await h.run(`INSERT INTO leads (customer_id,name,email,phone,service,source,stage,message,quote_json) VALUES (?,?,?,?,?,?,?,?,?)`,
    lead.customer_id ?? null, lead.name, lead.email ?? null, lead.phone ?? null, lead.service || 'storage', lead.source || 'website',
    lead.stage || 'new', lead.message ?? null, lead.quote ? JSON.stringify(lead.quote) : null);
  const id = Number(r.lastInsertRowid);
  await audit(h, user, 'create', 'lead', id, { source: lead.source, service: lead.service });
  await screenWatchlist(h, 'lead', id, lead);
  await notify(h, { to: h.setting('staff_email', 'office@cockatoomarine.example'), template: 'staff_new_lead',
    vars: { name: lead.name, service: lead.service || 'storage', source: lead.source || 'website', id } });
  return id;
}

// ---------- Watchlist screening (alerts staff only; never blocks or tells the customer) ----------
async function screenWatchlist(h, entity, entityId, subject) {
  const matches = C.matchWatchlist(await h.all('SELECT * FROM watchlist'), subject);
  for (const m of matches) {
    await h.run('INSERT INTO watch_alerts (watch_id,entity,entity_id,detail) VALUES (?,?,?,?)', m.watch.id, entity, entityId,
      `Matched on ${m.reasons.join(', ')}`);
    await notify(h, { to: h.setting('admin_email', 'admin@cockatoomarine.example'), subject: `Watchlist alert: ${entity} #${entityId}`,
      body: `A new ${entity} matched a watchlist entry on ${m.reasons.join(', ')}. Review it in the admin before proceeding.` });
  }
  return matches;
}

// ---------- Deposits & confirmation ----------
async function confirmBooking(h, bookingId, payment, user) {
  return await h.tx(async () => {
    const b = await h.get('SELECT * FROM bookings WHERE id=?', bookingId);
    if (!b) throw new Error('Booking not found.');
    if (['confirmed', 'active'].includes(b.status) && b.deposit_paid) return b; // idempotent (webhook retries)
    // Re-asserting an active status re-runs the overlap trigger: if a hold lapsed and someone else took the bay, this throws.
    await updateBooking(h, bookingId, { status: 'confirmed', deposit_paid: 1, hold_expires_at: null, pending_expires_at: null }, user, 'Deposit received');
    const cust = await h.get('SELECT * FROM customers WHERE id=?', b.customer_id);
    const today = C.todaySyd();
    const inv = await createInvoice(h, {
      customer_id: b.customer_id, booking_id: b.id, period: 'deposit', kind: 'deposit', issue_date: today, due_date: today,
      lines: [{ description: `Reservation fee / deposit – booking ${b.ref}`, category: 'deposit', billing: 'advance', qty: 1,
        unit_inc: payment.amount, amount_inc: C.round2(payment.amount), gst: C.gstOf(payment.amount) }],
    }, user);
    await recordPayment(h, { ...payment, customer_id: b.customer_id, booking_id: b.id, invoice_id: inv.id, kind: 'deposit' }, user);
    await h.run(`INSERT INTO contracts (booking_id,customer_id,term,package,monthly_rate,start_date,end_date,tc_version,tc_accepted_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, b.id, b.customer_id, b.term, b.package, b.monthly_rate, b.start_date, b.end_date,
      h.setting('tc_version', 'v1-draft'), payment.tc_accepted_at || new Date().toISOString());
    if (b.lead_id) await h.run(`UPDATE leads SET stage='booked', updated_at=? WHERE id=?`, new Date().toISOString(), b.lead_id);
    const bay = await h.get('SELECT code FROM bays WHERE id=?', b.bay_id);
    if (cust?.email) await notify(h, { to: cust.email, template: 'booking_confirmed', customerId: cust.id, dedupe: `confirm-${b.id}`,
      vars: { name: cust.name, ref: b.ref, start: C.fmtDate(b.start_date), bay: bay.code, package: b.package, term: b.term,
        rate: C.aud(b.monthly_rate), deposit: C.aud(payment.amount), link: `${h.setting('base_url', '')}/booking/${b.ref}` } });
    await notify(h, { to: h.setting('staff_email', ''), subject: `Booking confirmed ${b.ref}`, body: `${cust?.name} – bay ${bay.code} from ${b.start_date}. Deposit ${C.aud(payment.amount)} via ${payment.method}.` });
    return await h.get('SELECT * FROM bookings WHERE id=?', bookingId);
  });
}

async function createInvoice(h, { customer_id, booking_id, period, kind, issue_date, due_date, lines }, user) {
  // Invoice numbers are sequential, so numbering + insert run under the write lock.
  return h.tx(async () => {
    const total = C.round2(lines.reduce((s, l) => s + l.amount_inc, 0));
    const gst = C.round2(lines.reduce((s, l) => s + (l.gst ?? C.gstOf(l.amount_inc)), 0));
    const n = ((await h.get('SELECT COUNT(*) n FROM invoices')).n || 0) + 1001;
    const r = await h.run(`INSERT INTO invoices (number,customer_id,booking_id,period,issue_date,due_date,subtotal_ex,gst,total,kind) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      `INV-${n}`, customer_id, booking_id ?? null, period, issue_date, due_date, C.round2(total - gst), gst, total, kind || 'storage');
    const id = Number(r.lastInsertRowid);
    for (const l of lines) {
      await h.run('INSERT INTO invoice_lines (invoice_id,description,category,billing,qty,unit_inc,amount_inc,gst) VALUES (?,?,?,?,?,?,?,?)',
        id, l.description, l.category, l.billing, l.qty ?? 1, l.unit_inc, l.amount_inc, l.gst ?? C.gstOf(l.amount_inc));
      if (l.extra_id) await h.run('UPDATE extras SET invoice_id=? WHERE id=?', id, l.extra_id);
    }
    await audit(h, user, 'create', 'invoice', id, { total, period });
    return await h.get('SELECT * FROM invoices WHERE id=?', id);
  });
}

async function recordPayment(h, p, user) {
  const r = await h.run(`INSERT INTO payments (customer_id,booking_id,invoice_id,amount,method,reference,paid_on,kind,reconciled,recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    p.customer_id ?? null, p.booking_id ?? null, p.invoice_id ?? null, C.round2(p.amount), p.method, p.reference ?? null,
    p.paid_on || C.todaySyd(), p.kind || 'invoice', p.method === 'stripe' ? 1 : 0, user?.id ?? null);
  if (p.invoice_id) {
    const inv = await h.get('SELECT * FROM invoices WHERE id=?', p.invoice_id);
    const paid = C.round2((inv.paid || 0) + Number(p.amount));
    await h.run('UPDATE invoices SET paid=?, status=? WHERE id=?', paid, paid >= inv.total - 0.005 ? 'paid' : inv.status, inv.id);
  }
  await audit(h, user, 'create', 'payment', Number(r.lastInsertRowid), { amount: p.amount, method: p.method, reference: p.reference });
}

// Monthly run: storage in advance for `period`, extras from earlier months in arrears.
async function runMonthlyInvoicing(h, period, user) {
  const start = `${period}-01`, end = C.addMonths(start, 1);
  const bookings = await h.all(`SELECT * FROM bookings WHERE kind='storage' AND status IN ('confirmed','active') AND start_date < ? AND end_date > ?`, end, start);
  const created = [];
  for (const b of bookings) {
    if (await h.get(`SELECT 1 FROM invoices WHERE booking_id=? AND period=? AND kind='storage'`, b.id, period)) continue;
    const extras = await h.all('SELECT * FROM extras WHERE booking_id=? AND invoice_id IS NULL', b.id);
    const built = C.buildInvoice({ booking: b, period, extras });
    created.push(await createInvoice(h, { customer_id: b.customer_id, booking_id: b.id, period, kind: 'storage',
      issue_date: C.todaySyd(), due_date: start > C.todaySyd() ? start : C.addDays(C.todaySyd(), 7), lines: built.lines }, user));
  }
  return created;
}

// ---------- Lifts ----------
async function liftSlots(h, date) {
  const [open, close] = h.setting('lift_hours', '07:00-16:00').split('-');
  const step = Number(h.setting('lift_slot_minutes', 60));
  const cap = Number(h.setting('lift_slot_capacity', 2));
  const blackouts = h.setting('lift_blackouts', '').split(',').map((s) => s.trim()).filter(Boolean);
  if (blackouts.includes(date)) return [];
  const toMin = (t) => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
  const slots = [];
  for (let m = toMin(open); m + step <= toMin(close); m += step) {
    const slot = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const used = (await h.get(`SELECT COUNT(*) n FROM lifts WHERE date=? AND slot=? AND status<>'cancelled'`, date, slot)).n;
    slots.push({ slot, used, cap, free: cap - used });
  }
  return slots;
}

async function bookLift(h, { booking_id, date, slot, engine_flush, notes, via }, user) {
  return await h.tx(async () => {
    const b = await h.get('SELECT * FROM bookings WHERE id=?', booking_id);
    if (!b || !['confirmed', 'active'].includes(b.status)) throw new Error('Lifts can only be booked against an active storage booking.');
    const s = (await liftSlots(h, date)).find((x) => x.slot === slot);
    if (!s) throw new Error('That time is outside lift hours or on a blackout day.');
    if (s.free <= 0) throw new Error('That slot is full. Pick another time.');
    const month = date.slice(0, 7);
    const used = (await h.get(`SELECT COUNT(*) n FROM lifts WHERE booking_id=? AND substr(date,1,7)=? AND status<>'cancelled'`, booking_id, month)).n;
    const extra = C.isExtraLift(b.package, used) ? 1 : 0;
    if (engine_flush && b.package !== 'unlimited') throw new Error('Engine flush is included with the Unlimited package only.');
    const r = await h.run(`INSERT INTO lifts (booking_id,boat_id,date,slot,is_extra,engine_flush,notes,booked_via,created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      booking_id, b.boat_id, date, slot, extra, engine_flush ? 1 : 0, notes ?? null, via || 'staff', user?.id ?? null);
    const id = Number(r.lastInsertRowid);
    if (extra) await h.run(`INSERT INTO extras (booking_id,customer_id,date,description,category,amount_inc,source_type,source_id) VALUES (?,?,?,?,?,?,?,?)`,
      booking_id, b.customer_id, date, 'Extra lift', 'extra_lift', C.EXTRA_LIFT_FEE, 'lift', id);
    await audit(h, user, 'create', 'lift', id, { date, slot, extra: !!extra });
    const cust = await h.get('SELECT * FROM customers WHERE id=?', b.customer_id);
    if (cust?.email) await notify(h, { to: cust.email, template: 'lift_confirmed', customerId: cust.id,
      vars: { name: cust.name, date: C.fmtDate(date), slot, extra: extra ? `This is an extra lift ($${C.EXTRA_LIFT_FEE}, invoiced next month).` : '' } });
    return { id, extra: !!extra, usedBefore: used };
  });
}

// ---------- Holds & scheduled jobs ----------
async function expireHolds(h) {
  const r = await h.run(`UPDATE bookings SET status='expired' WHERE status='hold' AND hold_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  return Number(r.changes);
}

async function runScheduledJobs(h) {
  const today = C.todaySyd();
  const nowIso = new Date().toISOString();
  const log = [];
  log.push(`Expired holds: ${await expireHolds(h)}`);

  // Pending manual payments: remind 24h before expiry, then expire.
  for (const b of await h.all(`SELECT b.*, c.email, c.name FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.status='pending'`)) {
    if (b.pending_expires_at <= nowIso) {
      await updateBooking(h, b.id, { status: 'expired' }, null, 'Deposit not received in time');
      await notify(h, { to: b.email, template: 'booking_expired', vars: { name: b.name, ref: b.ref }, dedupe: `expired-${b.id}`, customerId: b.customer_id });
      log.push(`Expired pending booking ${b.ref}`);
    } else if (new Date(b.pending_expires_at) - Date.now() < 86400000) {
      if (await notify(h, { to: b.email, template: 'payment_reminder', vars: { name: b.name, ref: b.ref, amount: C.aud(b.deposit_amount), expires: C.fmtDateTime(b.pending_expires_at) }, dedupe: `deposit-remind-${b.id}`, customerId: b.customer_id }))
        log.push(`Deposit reminder ${b.ref}`);
    }
  }
  // Overdue invoices.
  for (const inv of await h.all(`SELECT i.*, c.email, c.name FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.status='issued' AND i.due_date < ?`, today)) {
    await h.run(`UPDATE invoices SET status='overdue' WHERE id=?`, inv.id);
    await notify(h, { to: inv.email, template: 'invoice_overdue', vars: { name: inv.name, number: inv.number, amount: C.aud(inv.total - inv.paid) }, dedupe: `overdue-${inv.id}`, customerId: inv.customer_id });
    log.push(`Overdue ${inv.number}`);
  }
  // Renewal reminders at 60 and 30 days.
  for (const days of [60, 30]) {
    const target = C.addDays(today, days);
    for (const b of await h.all(`SELECT b.*, c.email, c.name FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.kind='storage' AND b.status IN ('confirmed','active') AND b.end_date <= ? AND b.end_date > ?`, target, today)) {
      if (await notify(h, { to: b.email, template: 'renewal_reminder', vars: { name: b.name, ref: b.ref, end: C.fmtDate(b.end_date), days }, dedupe: `renew${days}-${b.id}`, customerId: b.customer_id }))
        log.push(`Renewal ${days}d ${b.ref}`);
    }
  }
  // Insurance expiry (30 days).
  for (const bt of await h.all(`SELECT bt.*, c.email, c.name owner FROM boats bt JOIN customers c ON c.id=bt.customer_id WHERE bt.insurance_expiry IS NOT NULL AND bt.insurance_expiry <= ?`, C.addDays(today, 30))) {
    if (await notify(h, { to: bt.email, template: 'insurance_expiry', vars: { name: bt.owner, boat: bt.name || bt.make_model, expiry: C.fmtDate(bt.insurance_expiry) }, dedupe: `ins-${bt.id}-${bt.insurance_expiry}`, customerId: bt.customer_id }))
      log.push(`Insurance reminder ${bt.name}`);
  }
  // Lift reminders for tomorrow.
  const tomorrow = C.addDays(today, 1);
  for (const l of await h.all(`SELECT l.*, c.email, c.name FROM lifts l JOIN bookings b ON b.id=l.booking_id JOIN customers c ON c.id=b.customer_id WHERE l.date=? AND l.status='booked'`, tomorrow)) {
    await notify(h, { to: l.email, template: 'lift_reminder', vars: { name: l.name, date: C.fmtDate(l.date), slot: l.slot }, dedupe: `liftrem-${l.id}` });
  }
  // Recurring maintenance: when a scheduled job is done, the next one is created on completion (see admin). Flag overdue here.
  const due = await h.all(`SELECT m.*, a.name asset FROM maintenance_jobs m JOIN assets a ON a.id=m.asset_id WHERE m.status<>'done' AND m.due_date <= ?`, C.addDays(today, 7));
  // Daily staff digest.
  const digest = await dailyDigest(h, today, due);
  if (await notify(h, { to: h.setting('staff_email', ''), subject: `Daily digest – ${C.fmtDate(today)}`, body: digest, dedupe: `digest-${today}` }))
    log.push('Daily digest sent');
  return log;
}

async function dailyDigest(h, today, due) {
  const lifts = await h.all(`SELECT l.slot, bt.name FROM lifts l LEFT JOIN boats bt ON bt.id=l.boat_id WHERE l.date=? AND l.status='booked' ORDER BY slot`, today);
  const arrivals = await h.all(`SELECT b.ref, c.name FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.start_date=? AND b.status IN ('confirmed','active')`, today);
  const overdue = await h.get(`SELECT COUNT(*) n, COALESCE(SUM(total-paid),0) amt FROM invoices WHERE status='overdue'`);
  return [
    `Lifts today (${lifts.length}): ${lifts.map((l) => `${l.slot} ${l.name}`).join(', ') || 'none'}`,
    `Arrivals today (${arrivals.length}): ${arrivals.map((a) => `${a.ref} ${a.name}`).join(', ') || 'none'}`,
    `Overdue invoices: ${overdue.n} (${C.aud(overdue.amt)})`,
    `Maintenance due within 7 days: ${due.map((d) => `${d.asset}: ${d.title} (${d.due_date})`).join('; ') || 'none'}`,
  ].join('\n');
}

module.exports = {
  ACTIVE, audit, notify, providers, getQuote, depositOpts, bookingEnd, availableBays, createBooking, updateBooking,
  upsertCustomer, createLead, screenWatchlist, confirmBooking, createInvoice, recordPayment, runMonthlyInvoicing,
  liftSlots, bookLift, expireHolds, runScheduledJobs, newRef,
};
