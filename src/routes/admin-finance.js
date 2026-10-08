// Invoices, payments, expenses, reports, watchlist, CSV import, settings, outbox and audit.
const crypto = require('node:crypto');
const C = require('../core');
const S = require('../services');
const { html, raw, pill, table, field, money, d, dt, label } = require('../ui');

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows) => rows.length ? [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(csvCell).join(','))].join('\n') : '';
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  return body.map((r) => Object.fromEntries(head.map((k, i) => [k.trim().toLowerCase(), (r[i] ?? '').trim()])));
}

module.exports = (r, h, { page, back, flash, can, today, upload }) => {
  // ======================= INVOICES =======================
  r.get('/invoices', (req, res) => {
    const st = req.query.status || '';
    const rows = h.all(`SELECT i.*, c.name cname FROM invoices i JOIN customers c ON c.id=i.customer_id ${st ? 'WHERE i.status=?' : ''} ORDER BY i.issue_date DESC, i.id DESC`, ...(st ? [st] : []));
    const period = C.addMonths(C.monthStart(today()), 1).slice(0, 7);
    page(req, res, 'Invoices', html`
      <form class="filters"><select name="status" aria-label="Status"><option value="">All</option>${['issued', 'paid', 'overdue', 'void'].map((s) => html`<option value="${s}" ${raw(s === st ? 'selected' : '')}>${label(s)}</option>`)}</select><button class="btn btn-brand btn-sm">Filter</button><a class="btn btn-outline btn-sm" href="/admin/reports/export/invoices.csv">Export CSV</a></form>
      <div class="card"><h2>Monthly invoice run</h2><form method="post" action="/admin/invoices/run" class="inline-form">${field('period', 'Billing month', { type: 'month', value: period })}<button class="btn btn-brand btn-sm">Generate invoices</button></form>
        <p class="small muted">Creates one invoice per active booking: storage for the chosen month (in advance) plus any uninvoiced extras from earlier months (in arrears). Safe to run twice.</p></div>
      <div class="card">${table([{ h: 'Number', f: (i) => html`<a href="/admin/invoices/${i.id}">${i.number}</a>` }, { h: 'Customer', k: 'cname' }, { h: 'Kind', f: (i) => label(i.kind) }, { h: 'Period', k: 'period' }, { h: 'Issued', f: (i) => d(i.issue_date) }, { h: 'Due', f: (i) => d(i.due_date) },
        { h: 'Total', num: 1, f: (i) => money(i.total) }, { h: 'GST', num: 1, f: (i) => money(i.gst) }, { h: 'Owing', num: 1, f: (i) => i.status === 'void' ? '—' : money(i.total - i.paid) }, { h: 'Status', f: (i) => pill(i.status) }], rows)}</div>`);
  });
  r.post('/invoices/run', (req, res) => {
    if (!/^\d{4}-\d{2}$/.test(req.body.period || '')) return back(req, res, 'Choose a month.');
    const made = S.runMonthlyInvoicing(h, req.body.period, req.user);
    for (const inv of made) {
      const c = h.get('SELECT * FROM customers WHERE id=?', inv.customer_id);
      S.notify(h, { to: c.email, customerId: c.id, subject: `Tax invoice ${inv.number} – ${C.aud(inv.total)}`, body: `Hi ${c.name},\n\nYour invoice ${inv.number} for ${inv.period} is ${C.aud(inv.total)} (incl. GST ${C.aud(inv.gst)}), due ${C.fmtDate(inv.due_date)}.\nPay online: ${h.setting('base_url')}/portal/invoices/${inv.id}\n\nCockatoo Marine` });
    }
    flash(res, `${made.length} invoice(s) created for ${req.body.period}.`); res.redirect('/admin/invoices');
  });
  r.get('/invoices/:id', (req, res, next) => {
    const body = renderInvoice(h, req.params.id, res.locals.biz);
    if (!body) return next();
    const inv = h.get('SELECT * FROM invoices WHERE id=?', req.params.id);
    const pays = h.all('SELECT p.*, u.name uname FROM payments p LEFT JOIN users u ON u.id=p.recorded_by WHERE invoice_id=?', inv.id);
    page(req, res, `Invoice ${inv.number}`, html`<div class="no-print" style="margin-bottom:12px;display:flex;gap:8px"><button class="btn btn-brand btn-sm" onclick="window.print()">Print / save PDF</button>
        ${inv.status !== 'void' && inv.paid === 0 && can(req.user, 'admin', 'finance') ? html`<form method="post" action="/admin/invoices/${inv.id}/void"><button class="btn btn-outline btn-sm" data-confirm="Void this invoice?">Void</button></form>` : ''}</div>
      ${body}
      <div class="cols no-print">
        <div class="card"><h2>Payments</h2>${table([{ h: 'Date', f: (p) => d(p.paid_on) }, { h: 'Amount', num: 1, f: (p) => money(p.amount) }, { h: 'Method', f: (p) => label(p.method) }, { h: 'Ref', k: 'reference' }, { h: 'By', k: 'uname' },
          { h: 'Reconciled', f: (p) => p.reconciled ? pill('ok', 'Yes') : html`<form method="post" action="/admin/payments/${p.id}/reconcile"><button class="btn btn-outline btn-sm">Mark reconciled</button></form>` }], pays)}</div>
        ${inv.status !== 'paid' && inv.status !== 'void' ? html`<form class="card" method="post" action="/admin/invoices/${inv.id}/pay"><h2>Record payment</h2>
          <div class="row">${field('amount', 'Amount', { type: 'number', value: C.round2(inv.total - inv.paid), attrs: 'step="0.01"' })}${field('method', 'Method', { options: [['bank_transfer', 'Bank transfer'], ['card_phone', 'Card over the phone'], ['cash', 'Cash'], ['stripe', 'Stripe (manual entry)']] })}</div>
          <div class="row">${field('reference', 'Reference', { required: true })}${field('paid_on', 'Date', { type: 'date', value: today() })}</div><button class="btn btn-brand">Record payment</button></form>` : ''}
      </div>`, { active: '/admin/invoices' });
  });
  r.post('/invoices/:id/pay', (req, res) => {
    const inv = h.get('SELECT * FROM invoices WHERE id=?', req.params.id);
    if (!(Number(req.body.amount) > 0) || !req.body.reference) return back(req, res, 'Enter an amount and reference.');
    S.recordPayment(h, { invoice_id: inv.id, customer_id: inv.customer_id, booking_id: inv.booking_id, amount: Number(req.body.amount), method: req.body.method, reference: req.body.reference, paid_on: req.body.paid_on }, req.user);
    flash(res, 'Payment recorded.'); res.redirect('/admin/invoices/' + inv.id);
  });
  r.post('/invoices/:id/void', (req, res) => { h.run(`UPDATE invoices SET status='void' WHERE id=?`, req.params.id); h.run('UPDATE extras SET invoice_id=NULL WHERE invoice_id=?', req.params.id); S.audit(h, req.user, 'void', 'invoice', Number(req.params.id)); flash(res, 'Invoice voided.'); res.redirect('/admin/invoices/' + req.params.id); });
  r.post('/payments/:id/reconcile', (req, res) => { h.run('UPDATE payments SET reconciled=1 WHERE id=?', req.params.id); S.audit(h, req.user, 'reconcile', 'payment', Number(req.params.id)); flash(res, 'Payment reconciled.'); res.redirect(req.get('referer') || '/admin/invoices'); });

  // ======================= EXPENSES =======================
  const CATS = ['Wages', 'Lease', 'Electricity', 'Fuel', 'Repairs', 'Insurance', 'Equipment', 'Marketing', 'Supplies', 'Other'];
  r.get('/expenses', (req, res) => {
    const rows = h.all('SELECT * FROM expenses ORDER BY date DESC LIMIT 300');
    page(req, res, 'Expenses', html`<div class="cols"><form class="card" method="post" action="/admin/expenses" enctype="multipart/form-data"><h2>Add expense</h2>
        <div class="row">${field('date', 'Date', { type: 'date', value: today() })}${field('category', 'Category', { options: CATS })}</div>
        <div class="row">${field('supplier', 'Supplier', { required: true })}${field('amount_inc', 'Amount incl. GST', { type: 'number', attrs: 'step="0.01"', required: true })}</div>
        <label class="check small"><input type="checkbox" name="no_gst" value="1"> No GST on this expense (e.g. wages)</label>
        ${field('description', 'Description')}<div class="field"><label for="rc">Receipt</label><input id="rc" type="file" name="receipt" accept="image/*,application/pdf" capture="environment"></div><button class="btn btn-brand">Save expense</button></form></div>
      <div class="card">${table([{ h: 'Date', f: (e) => d(e.date) }, { h: 'Category', k: 'category' }, { h: 'Supplier', k: 'supplier' }, { h: 'Description', k: 'description' }, { h: 'Amount', num: 1, f: (e) => money(e.amount_inc) }, { h: 'GST', num: 1, f: (e) => money(e.gst) }, { h: 'Receipt', f: (e) => e.receipt ? html`<a href="${e.receipt}" target="_blank">View</a>` : '—' }], rows)}</div>`,
      { actions: html`<a class="btn btn-outline btn-sm" href="/admin/reports/export/expenses.csv">Export CSV</a>` });
  });
  r.post('/expenses', upload.single('receipt'), (req, res) => {
    const b = req.body, amt = Number(b.amount_inc);
    if (!(amt > 0) || !b.supplier) return back(req, res, 'Enter a supplier and amount.');
    const x = h.run('INSERT INTO expenses (date,category,supplier,description,amount_inc,gst,receipt) VALUES (?,?,?,?,?,?,?)', b.date, b.category, b.supplier, b.description, amt, b.no_gst ? 0 : C.gstOf(amt), req.file ? '/uploads/' + req.file.filename : null);
    S.audit(h, req.user, 'create', 'expense', Number(x.lastInsertRowid), { amount: amt });
    flash(res, 'Expense saved.'); res.redirect('/admin/expenses');
  });

  // ======================= REPORTS =======================
  const pnl = (fromMonth, toMonth) => {
    const rev = h.all(`SELECT substr(issue_date,1,7) m, SUM(subtotal_ex) ex, SUM(gst) gst FROM invoices WHERE status<>'void' AND substr(issue_date,1,7) BETWEEN ? AND ? GROUP BY m`, fromMonth, toMonth);
    const exp = h.all(`SELECT substr(date,1,7) m, SUM(amount_inc-gst) ex FROM expenses WHERE substr(date,1,7) BETWEEN ? AND ? GROUP BY m`, fromMonth, toMonth);
    const months = []; for (let m = fromMonth; m <= toMonth; m = C.addMonths(m + '-01', 1).slice(0, 7)) months.push(m);
    return months.map((m) => { const r1 = rev.find((x) => x.m === m)?.ex || 0, e1 = exp.find((x) => x.m === m)?.ex || 0; return { month: m, revenue_ex_gst: C.round2(r1), expenses_ex_gst: C.round2(e1), profit: C.round2(r1 - e1) }; });
  };
  r.get('/reports', (req, res) => {
    const t = today();
    const tab = req.query.tab || 'sales';
    const to = t.slice(0, 7), from = C.addMonths(t, -11).slice(0, 7);
    let body;
    if (tab === 'sales') {
      const bays = h.get(`SELECT COUNT(*) n FROM bays WHERE status<>'out_of_service'`).n;
      const occ = h.get(`SELECT COUNT(DISTINCT bay_id) n FROM bookings WHERE kind='storage' AND status IN ('confirmed','active') AND start_date<=? AND end_date>?`, t, t).n;
      const mrr = h.get(`SELECT COALESCE(SUM(monthly_rate),0) v FROM bookings WHERE kind='storage' AND status IN ('confirmed','active') AND start_date<=? AND end_date>?`, t, t).v;
      const newB = h.get(`SELECT COUNT(*) n FROM bookings WHERE kind='storage' AND status IN ('confirmed','active') AND created_at >= ?`, C.addDays(t, -30)).n;
      const conv = h.all(`SELECT source, COUNT(*) leads, SUM(stage='booked') booked, SUM(stage='lost') lost FROM leads GROUP BY source ORDER BY leads DESC`);
      const avgLen = h.get(`SELECT AVG(bt.length_m) v FROM bookings b JOIN boats bt ON bt.id=b.boat_id WHERE b.status IN ('confirmed','active')`).v || 0;
      const ending = h.get(`SELECT COUNT(*) n FROM bookings WHERE kind='storage' AND status IN ('confirmed','active') AND end_date BETWEEN ? AND ?`, t, C.addDays(t, 90)).n;
      const churn = h.get(`SELECT COUNT(*) n FROM bookings WHERE kind='storage' AND status IN ('completed','cancelled') AND end_date >= ?`, C.addDays(t, -90)).n;
      const svc = h.all(`SELECT service, COUNT(*) n FROM leads GROUP BY service ORDER BY n DESC`);
      const pkg = h.all(`SELECT package, term, COUNT(*) n, SUM(monthly_rate) mrr FROM bookings WHERE kind='storage' AND status IN ('confirmed','active') GROUP BY package, term`);
      const maxSvc = Math.max(1, ...svc.map((s) => s.n));
      body = html`<div class="kpis">
        <div class="kpi"><div class="v">${Math.round(occ / bays * 100)}%</div><div class="l">Occupancy</div></div><div class="kpi"><div class="v">${money(mrr)}</div><div class="l">MRR (GST incl.)</div></div>
        <div class="kpi"><div class="v">${newB}</div><div class="l">New bookings (30 days)</div></div><div class="kpi"><div class="v">${avgLen.toFixed(1)} m</div><div class="l">Average boat length</div></div>
        <div class="kpi"><div class="v">${ending}</div><div class="l">Up for renewal (90 days)</div></div><div class="kpi"><div class="v">${churn}</div><div class="l">Ended / churned (90 days)</div></div></div>
        <div class="cols"><div class="card"><h2>Enquiry → booking conversion by source</h2>${table([{ h: 'Source', k: 'source' }, { h: 'Leads', k: 'leads', num: 1 }, { h: 'Booked', k: 'booked', num: 1 }, { h: 'Lost', k: 'lost', num: 1 }, { h: 'Conversion', num: 1, f: (x) => Math.round((x.booked / x.leads) * 100) + '%' }], conv)}</div>
        <div class="card"><h2>Enquiries by service</h2>${svc.map((s) => html`<div style="display:grid;grid-template-columns:110px 1fr 30px;gap:10px;align-items:center;margin-bottom:8px" class="small"><span>${label(s.service)}</span><div class="bar-h"><span style="width:${(s.n / maxSvc) * 100}%"></span></div><span class="num">${s.n}</span></div>`)}</div>
        <div class="card"><h2>Revenue by package</h2>${table([{ h: 'Package', f: (x) => `${label(x.package)} · ${label(x.term)}` }, { h: 'Boats', k: 'n', num: 1 }, { h: 'MRR', num: 1, f: (x) => money(x.mrr) }], pkg)}</div></div>`;
    }
    if (tab === 'pnl') {
      const rows = pnl(from, to);
      const max = Math.max(1, ...rows.map((r1) => Math.max(r1.revenue_ex_gst, r1.expenses_ex_gst)));
      const q = {}; for (const r1 of rows) { const k = r1.month.slice(0, 4) + ' Q' + Math.ceil(Number(r1.month.slice(5)) / 3); q[k] = q[k] || { quarter: k, revenue_ex_gst: 0, expenses_ex_gst: 0, profit: 0 }; for (const f of ['revenue_ex_gst', 'expenses_ex_gst', 'profit']) q[k][f] = C.round2(q[k][f] + r1[f]); }
      const byCat = h.all(`SELECT l.category, SUM(l.amount_inc - l.gst) ex FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.status<>'void' AND substr(i.issue_date,1,7) BETWEEN ? AND ? GROUP BY l.category ORDER BY ex DESC`, from, to);
      const costCat = h.all(`SELECT category, SUM(amount_inc-gst) ex FROM expenses WHERE substr(date,1,7) BETWEEN ? AND ? GROUP BY category ORDER BY ex DESC`, from, to);
      body = html`<div class="card"><h2>Profit &amp; loss, last 12 months (ex GST) <a class="btn btn-outline btn-sm" href="/admin/reports/export/pnl.csv">Export CSV</a></h2>
        <div style="display:flex;align-items:flex-end;gap:6px;height:180px;margin:10px 0 6px;border-bottom:1px solid var(--border)" role="img" aria-label="Monthly revenue and expenses">${rows.map((r1) => html`<div style="flex:1;display:flex;gap:2px;align-items:flex-end;height:100%" title="${r1.month}: revenue ${money(r1.revenue_ex_gst)}, expenses ${money(r1.expenses_ex_gst)}"><span style="flex:1;background:var(--brand);height:${(r1.revenue_ex_gst / max) * 100}%;border-radius:3px 3px 0 0"></span><span style="flex:1;background:#B8CFD6;height:${(r1.expenses_ex_gst / max) * 100}%;border-radius:3px 3px 0 0"></span></div>`)}</div>
        <div class="legend"><span style="--c:var(--brand)">Revenue</span><span style="--c:#B8CFD6">Operating costs</span></div>
        ${table([{ h: 'Month', k: 'month' }, { h: 'Revenue', num: 1, f: (x) => money(x.revenue_ex_gst) }, { h: 'Costs', num: 1, f: (x) => money(x.expenses_ex_gst) }, { h: 'Profit', num: 1, f: (x) => html`<b style="color:${x.profit < 0 ? 'var(--err)' : 'inherit'}">${money(x.profit)}</b>` }], rows)}</div>
        <div class="cols"><div class="card"><h2>By quarter</h2>${table([{ h: 'Quarter', k: 'quarter' }, { h: 'Revenue', num: 1, f: (x) => money(x.revenue_ex_gst) }, { h: 'Costs', num: 1, f: (x) => money(x.expenses_ex_gst) }, { h: 'Profit', num: 1, f: (x) => money(x.profit) }], Object.values(q))}
          <p class="small muted">Year to date profit: <b>${money(rows.filter((x) => x.month.startsWith(t.slice(0, 4))).reduce((s, x) => s + x.profit, 0))}</b></p></div>
        <div class="card"><h2>Revenue by service</h2>${table([{ h: 'Category', f: (x) => label(x.category) }, { h: 'Revenue ex GST', num: 1, f: (x) => money(x.ex) }], byCat)}</div>
        <div class="card"><h2>Operating costs</h2>${table([{ h: 'Category', k: 'category' }, { h: 'Ex GST', num: 1, f: (x) => money(x.ex) }], costCat)}</div></div>`;
    }
    if (tab === 'aging') {
      const rows = h.all(`SELECT i.*, c.name cname, julianday(?) - julianday(i.due_date) age FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.status IN ('issued','overdue') ORDER BY age DESC`, t);
      const bucket = (a) => a <= 0 ? 'Current' : a <= 30 ? '1–30 days' : a <= 60 ? '31–60 days' : a <= 90 ? '61–90 days' : '90+ days';
      const sums = {}; for (const x of rows) sums[bucket(x.age)] = (sums[bucket(x.age)] || 0) + x.total - x.paid;
      body = html`<div class="kpis">${['Current', '1–30 days', '31–60 days', '61–90 days', '90+ days'].map((b) => html`<div class="kpi"><div class="v">${money(sums[b] || 0)}</div><div class="l">${b}</div></div>`)}</div>
        <div class="card"><h2>Outstanding receivables <a class="btn btn-outline btn-sm" href="/admin/reports/export/receivables.csv">Export CSV</a></h2>${table([{ h: 'Invoice', f: (x) => html`<a href="/admin/invoices/${x.id}">${x.number}</a>` }, { h: 'Customer', k: 'cname' }, { h: 'Due', f: (x) => d(x.due_date) }, { h: 'Age', f: (x) => bucket(x.age) }, { h: 'Owing', num: 1, f: (x) => money(x.total - x.paid) }, { h: 'Status', f: (x) => pill(x.status) }], rows)}</div>`;
    }
    const tabs = [['sales', 'Sales dashboard'], ['pnl', 'Profit & loss'], ['aging', 'Receivables aging']];
    page(req, res, 'Reports', html`<nav class="tabs">${tabs.map(([k, l]) => html`<a href="?tab=${k}" ${raw(k === tab ? 'aria-current="page"' : '')}>${l}</a>`)}</nav>${body}
      <p class="small muted">Exports use flat, accounting-friendly columns (date, account category, ex-GST, GST) so a Xero or MYOB sync can be added later.</p>`);
  });
  r.get('/reports/export/:file', (req, res) => {
    if (!can(req.user, 'admin', 'finance', 'office')) return res.status(403).end();
    const t = today();
    const data = {
      'invoices.csv': () => h.all(`SELECT i.number, i.issue_date, i.due_date, c.name customer, c.email, i.kind, i.period, i.subtotal_ex, i.gst, i.total, i.paid, i.status FROM invoices i JOIN customers c ON c.id=i.customer_id ORDER BY i.issue_date`),
      'invoice-lines.csv': () => h.all(`SELECT i.number, i.issue_date, l.description, l.category account, l.billing, l.qty, l.amount_inc, l.gst, ROUND(l.amount_inc-l.gst,2) amount_ex FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id`),
      'payments.csv': () => h.all(`SELECT p.paid_on, i.number invoice, c.name customer, p.amount, p.method, p.reference, p.kind, p.reconciled FROM payments p LEFT JOIN invoices i ON i.id=p.invoice_id LEFT JOIN customers c ON c.id=p.customer_id ORDER BY p.paid_on`),
      'expenses.csv': () => h.all(`SELECT date, category account, supplier, description, amount_inc, gst, ROUND(amount_inc-gst,2) amount_ex FROM expenses ORDER BY date`),
      'pnl.csv': () => pnl(C.addMonths(t, -11).slice(0, 7), t.slice(0, 7)),
      'receivables.csv': () => h.all(`SELECT i.number, c.name customer, i.due_date, ROUND(i.total-i.paid,2) owing, i.status FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.status IN ('issued','overdue')`),
    }[req.params.file];
    if (!data) return res.status(404).end();
    S.audit(h, req.user, 'export', 'report', null, { file: req.params.file });
    res.type('text/csv').attachment(req.params.file).send(toCsv(data()));
  });

  // ======================= WATCHLIST (admin only, every access audited) =======================
  r.get('/watchlist', (req, res) => {
    S.audit(h, req.user, 'view', 'watchlist', null);
    const rows = h.all('SELECT w.*, u.name added FROM watchlist w LEFT JOIN users u ON u.id=w.added_by ORDER BY w.created_at DESC');
    const alerts = h.all(`SELECT a.*, w.name wname FROM watch_alerts a JOIN watchlist w ON w.id=a.watch_id ORDER BY a.resolved, a.created_at DESC LIMIT 50`);
    const edit = req.query.edit ? h.get('SELECT * FROM watchlist WHERE id=?', req.query.edit) : {};
    page(req, res, 'Risk watchlist', html`
      <div class="alert warn small">Internal and confidential. Record only factual, necessary information (Australian Privacy Act / APP 10 &amp; 13). Matches alert staff only: never auto-reject or tell the customer. Correct or remove entries when asked and the request is valid.</div>
      <div class="card"><h2>Alerts</h2>${table([{ h: 'When', f: (a) => dt(a.created_at) }, { h: 'Record', f: (a) => html`<a href="/admin/${a.entity === 'lead' ? 'leads' : a.entity === 'booking' ? 'bookings' : a.entity === 'customer' ? 'customers' : 'boats'}/${a.entity_id}">${label(a.entity)} #${a.entity_id}</a>` }, { h: 'Entry', k: 'wname' }, { h: 'Detail', k: 'detail' },
        { h: '', f: (a) => a.resolved ? pill('ok', 'Reviewed') : html`<form method="post" action="/admin/watchlist/alerts/${a.id}/resolve"><button class="btn btn-outline btn-sm">Mark reviewed</button></form>` }], alerts)}</div>
      <div class="cols"><div class="card"><h2>Entries</h2>${table([{ h: 'Name', k: 'name' }, { h: 'Email', k: 'email' }, { h: 'Phone', k: 'phone' }, { h: 'Rego / HIN', f: (w) => [w.rego, w.hin].filter(Boolean).join(' / ') }, { h: 'Reason', k: 'reason' }, { h: 'Added', f: (w) => html`${w.added || ''} <span class="small muted">${d(w.created_at.slice(0, 10))}</span>` },
        { h: '', f: (w) => html`<a class="btn btn-outline btn-sm" href="?edit=${w.id}">Edit</a> <form method="post" action="/admin/watchlist/${w.id}/delete" style="display:inline"><button class="btn btn-outline btn-sm" data-confirm="Remove this entry permanently?">Remove</button></form>` }], rows)}</div>
      <form class="card" method="post" action="/admin/watchlist${edit.id ? '/' + edit.id : ''}"><h2>${edit.id ? 'Edit entry' : 'Add entry'}</h2>
        ${field('name', 'Name', { value: edit.name, required: true })}<div class="row">${field('email', 'Email', { value: edit.email })}${field('phone', 'Phone', { value: edit.phone })}</div>
        <div class="row">${field('rego', 'Rego', { value: edit.rego })}${field('hin', 'HIN', { value: edit.hin })}</div>
        ${field('reason', 'Reason', { options: ['Non-payment', 'Fraud', 'Abuse / threatening behaviour', 'Property damage', 'Other'], value: edit.reason })}
        ${field('evidence', 'Evidence notes (facts only)', { type: 'textarea', value: edit.evidence })}<button class="btn btn-brand">${edit.id ? 'Save changes' : 'Add to watchlist'}</button></form></div>`);
  });
  const WCOLS = ['name', 'email', 'phone', 'rego', 'hin', 'reason', 'evidence'];
  r.post('/watchlist', (req, res) => { const x = h.run(`INSERT INTO watchlist (${WCOLS},added_by) VALUES (${WCOLS.map(() => '?')},?)`, ...WCOLS.map((k) => req.body[k] || null), req.user.id); S.audit(h, req.user, 'create', 'watchlist', Number(x.lastInsertRowid)); flash(res, 'Entry added.'); res.redirect('/admin/watchlist'); });
  r.post('/watchlist/alerts/:id/resolve', (req, res) => { h.run('UPDATE watch_alerts SET resolved=1 WHERE id=?', req.params.id); S.audit(h, req.user, 'resolve', 'watch_alert', Number(req.params.id)); flash(res, 'Alert marked reviewed.'); res.redirect(req.get('referer') || '/admin/watchlist'); });
  r.post('/watchlist/:id', (req, res) => { h.run(`UPDATE watchlist SET ${WCOLS.map((k) => k + '=?')}, updated_at=? WHERE id=?`, ...WCOLS.map((k) => req.body[k] || null), new Date().toISOString(), req.params.id); S.audit(h, req.user, 'update', 'watchlist', Number(req.params.id)); flash(res, 'Entry updated.'); res.redirect('/admin/watchlist'); });
  r.post('/watchlist/:id/delete', (req, res) => { h.run('DELETE FROM watch_alerts WHERE watch_id=?', req.params.id); h.run('DELETE FROM watchlist WHERE id=?', req.params.id); S.audit(h, req.user, 'delete', 'watchlist', Number(req.params.id)); flash(res, 'Entry removed.'); res.redirect('/admin/watchlist'); });

  // ======================= CSV IMPORT (dry run first) =======================
  const IMPORTS = {
    customers: { cols: 'name,email,phone,kind,company,address,source,notes', required: ['name'],
      check: (r1) => (r1.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r1.email) ? 'invalid email' : null),
      insert: (r1) => h.run('INSERT INTO customers (name,email,phone,kind,company,address,source,notes) VALUES (?,?,?,?,?,?,?,?)', r1.name, r1.email || null, r1.phone || null, r1.kind === 'company' ? 'company' : 'individual', r1.company || null, r1.address || null, r1.source || 'import', r1.notes || null) },
    boats: { cols: 'customer_email,name,make_model,length_m,rego,hin,insurance_expiry', required: ['customer_email', 'length_m'],
      check: (r1) => !h.get('SELECT 1 FROM customers WHERE lower(email)=lower(?)', r1.customer_email) ? 'customer email not found' : !(Number(r1.length_m) > 0) ? 'length_m must be a number' : null,
      insert: (r1) => h.run('INSERT INTO boats (customer_id,name,make_model,length_m,rego,hin,insurance_expiry,qr_token) VALUES ((SELECT id FROM customers WHERE lower(email)=lower(?)),?,?,?,?,?,?,?)', r1.customer_email, r1.name || 'Boat', r1.make_model || null, Number(r1.length_m), r1.rego || null, r1.hin || null, r1.insurance_expiry || null, crypto.randomBytes(12).toString('base64url')) },
    bays: { cols: 'code,zone,max_length_m', required: ['code', 'max_length_m'],
      check: (r1) => h.get('SELECT 1 FROM bays WHERE code=?', r1.code) ? 'bay code already exists' : null,
      insert: (r1) => h.run('INSERT INTO bays (code,zone,max_length_m) VALUES (?,?,?)', r1.code, r1.zone || null, Number(r1.max_length_m)) },
    bookings: { cols: 'customer_email,boat_rego_or_name,bay_code,package,term,monthly_rate,start_date,end_date', required: ['customer_email', 'bay_code', 'start_date', 'end_date'],
      check: (r1) => {
        if (!h.get('SELECT 1 FROM customers WHERE lower(email)=lower(?)', r1.customer_email)) return 'customer email not found';
        const bay = h.get('SELECT id FROM bays WHERE code=?', r1.bay_code); if (!bay) return 'bay not found';
        if (!(r1.end_date > r1.start_date)) return 'end_date must be after start_date';
        if (h.get(`SELECT 1 FROM bookings WHERE bay_id=? AND status IN ('confirmed','active','pending','maintenance') AND start_date<? AND ?<end_date`, bay.id, r1.end_date, r1.start_date)) return 'overlaps an existing booking in that bay';
        return null;
      },
      insert: (r1) => {
        const c = h.get('SELECT id FROM customers WHERE lower(email)=lower(?)', r1.customer_email);
        const boat = h.get('SELECT id FROM boats WHERE customer_id=? AND (rego=? OR name=?)', c.id, r1.boat_rego_or_name, r1.boat_rego_or_name);
        return S.createBooking(h, { bay_id: h.get('SELECT id FROM bays WHERE code=?', r1.bay_code).id, customer_id: c.id, boat_id: boat?.id, package: r1.package || 'standard', term: r1.term || 'annual', monthly_rate: Number(r1.monthly_rate) || null, start_date: r1.start_date, end_date: r1.end_date, status: r1.start_date <= today() ? 'active' : 'confirmed', notes: 'Imported' }, null);
      } },
    balances: { cols: 'customer_email,amount,description,due_date', required: ['customer_email', 'amount'],
      check: (r1) => !h.get('SELECT 1 FROM customers WHERE lower(email)=lower(?)', r1.customer_email) ? 'customer email not found' : !(Number(r1.amount) > 0) ? 'amount must be positive' : null,
      insert: (r1) => S.createInvoice(h, { customer_id: h.get('SELECT id FROM customers WHERE lower(email)=lower(?)', r1.customer_email).id, period: 'opening', kind: 'opening_balance', issue_date: today(), due_date: r1.due_date || today(), lines: [{ description: r1.description || 'Opening balance (migrated)', category: 'opening_balance', billing: 'arrears', qty: 1, unit_inc: Number(r1.amount), amount_inc: Number(r1.amount) }] }, null) },
  };
  r.get('/import', (req, res) => page(req, res, 'Import from Google Sheets', html`
    <p class="muted">Export each Google Sheet as CSV, then import in this order: bays, customers, boats, bookings, balances. Always run a dry run first.</p>
    <form class="card" method="post" action="/admin/import" enctype="multipart/form-data" style="max-width:860px">
      ${field('entity', 'What are you importing?', { options: Object.keys(IMPORTS).map((k) => [k, `${label(k)} (columns: ${IMPORTS[k].cols})`]) })}
      <div class="field"><label for="file">CSV file</label><input id="file" type="file" name="file" accept=".csv,text/csv"></div>
      ${field('csv', 'Or paste CSV (first row = column names)', { type: 'textarea', rows: 6 })}
      <div style="display:flex;gap:8px"><button class="btn btn-outline" name="mode" value="dry">Dry run (validate only)</button><button class="btn btn-brand" name="mode" value="commit" data-confirm="Import valid rows now?">Import</button></div></form>`));
  const csvUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
  r.post('/import', csvUpload.single('file'), (req, res) => {
    const spec = IMPORTS[req.body.entity];
    if (!spec) return back(req, res, 'Choose what to import.');
    const text = req.file ? req.file.buffer.toString('utf8') : req.body.csv || '';
    const rows = parseCsv(text.replace(/^﻿/, ''));
    if (!rows.length) return back(req, res, 'No rows found. Check the first row has column names.');
    const report = rows.map((r1, i) => {
      const missing = spec.required.filter((k) => !r1[k]);
      return { line: i + 2, row: r1, error: missing.length ? 'missing ' + missing.join(', ') : spec.check(r1) };
    });
    let imported = 0;
    if (req.body.mode === 'commit') {
      for (const x of report.filter((x) => !x.error)) {
        try { h.tx(() => spec.insert(x.row)); imported++; } catch (e) { x.error = e.message; }
      }
      S.audit(h, req.user, 'import', req.body.entity, null, { rows: rows.length, imported });
    }
    const bad = report.filter((x) => x.error);
    page(req, res, 'Import result', html`
      <div class="alert ${bad.length ? 'warn' : 'ok'}">${req.body.mode === 'commit' ? `Imported ${imported} of ${rows.length} rows.` : `Dry run: ${rows.length - bad.length} of ${rows.length} rows are valid. Nothing was saved.`}</div>
      <div class="card"><h2>Rows</h2>${table([{ h: 'Line', k: 'line' }, { h: 'Data', f: (x) => html`<span class="small">${Object.values(x.row).join(' · ')}</span>` }, { h: 'Result', f: (x) => x.error ? pill('err', x.error) : pill('ok', req.body.mode === 'commit' ? 'Imported' : 'Valid') }], report)}</div>
      <a class="btn btn-outline" href="/admin/import">Back to import</a>`, { active: '/admin/import' });
  });

  // ======================= SETTINGS =======================
  r.get('/settings', (req, res) => {
    const tab = req.query.tab || 'general';
    let body;
    if (tab === 'general') {
      const s = h.all('SELECT * FROM settings ORDER BY key');
      body = html`<form class="card" method="post" action="/admin/settings" style="max-width:820px"><p class="small muted">Values flagged “confirm” are placeholders awaiting the client.</p>
        ${s.map((x) => html`<div class="field"><label for="s_${x.key}">${label(x.key)} ${x.placeholder ? pill('warn', 'Confirm') : ''}</label><input id="s_${x.key}" name="${x.key}" value="${x.value}"></div>`)}<button class="btn btn-brand">Save settings</button></form>`;
    }
    if (tab === 'rates') {
      const rates = h.all('SELECT * FROM rates ORDER BY package, term, min_len');
      body = html`<form class="card" method="post" action="/admin/settings/rates"><div class="alert warn small">Placeholder rate table. Only “from $547/month” is confirmed. Edit and save to clear the placeholder flag.</div>
        ${table([{ h: 'Package', f: (x) => label(x.package) }, { h: 'Term', f: (x) => label(x.term) }, { h: 'Length band', f: (x) => html`<input name="min_${x.id}" value="${x.min_len}" style="width:80px;min-height:36px;padding:6px" aria-label="Min length"> – <input name="max_${x.id}" value="${x.max_len}" style="width:80px;min-height:36px;padding:6px" aria-label="Max length"> m` },
          { h: 'Monthly rate (incl. GST)', f: (x) => html`<input name="rate_${x.id}" value="${x.monthly_rate}" type="number" step="0.01" style="width:120px;min-height:36px;padding:6px" aria-label="Rate">` }, { h: '', f: (x) => x.placeholder ? pill('warn', 'Placeholder') : pill('ok', 'Confirmed') }], rates)}
        <button class="btn btn-brand" style="margin-top:12px">Save rates</button></form>`;
    }
    if (tab === 'emails') {
      const t = h.all('SELECT * FROM email_templates ORDER BY key');
      body = html`${t.map((x) => html`<form class="card" method="post" action="/admin/settings/emails/${x.key}"><h2>${label(x.key)}</h2>${field('subject', 'Subject', { value: x.subject })}${field('body', 'Body', { type: 'textarea', value: x.body, rows: 6 })}<span class="small muted">Use {{placeholders}} such as {{name}}, {{ref}}.</span><br><button class="btn btn-brand btn-sm" style="margin-top:8px">Save</button></form>`)}`;
    }
    if (tab === 'checklists') {
      const t = h.all('SELECT * FROM checklist_templates ORDER BY type');
      body = html`${t.map((x) => html`<form class="card" method="post" action="/admin/settings/checklists/${x.id}"><h2>${x.name} ${pill('info', label(x.type))}</h2>
        ${field('items', 'One item per line: Section | Label | required (yes/no) | photo (yes/no)', { type: 'textarea', rows: 12, value: JSON.parse(x.items).map((i) => `${i.section} | ${i.label} | ${i.required ? 'yes' : 'no'} | ${i.photo ? 'yes' : 'no'}`).join('\n') })}<button class="btn btn-brand btn-sm">Save template</button></form>`)}`;
    }
    if (tab === 'users') {
      const u = h.all(`SELECT * FROM users ORDER BY role, name`);
      body = html`<div class="card">${table([{ h: 'Name', k: 'name' }, { h: 'Email', k: 'email' }, { h: 'Role', f: (x) => pill('info', x.role) }, { h: '2FA', f: (x) => x.role === 'customer' ? '—' : x.totp_enabled ? pill('ok', 'On') : pill('muted', 'Off') }], u)}</div>
        <form class="card" method="post" action="/admin/settings/users" style="max-width:640px"><h2>Add staff user</h2><div class="row">${field('name', 'Name', { required: true })}${field('email', 'Email', { type: 'email', required: true })}</div>
        <div class="row">${field('role', 'Role', { options: ['office', 'yard', 'finance', 'admin'] })}${field('password', 'Temporary password', { type: 'password', required: true, attrs: 'minlength="8"' })}</div><button class="btn btn-brand">Add user</button></form>
        <div class="card small muted">Two-step verification (TOTP) is modelled per user (totp_enabled) and is the next auth task; see docs/PLAN.md.</div>`;
    }
    if (tab === 'integrations') {
      const i = h.all('SELECT * FROM integrations');
      body = html`<div class="card">${table([{ h: 'Provider', k: 'provider' }, { h: 'Kind', k: 'kind' }, { h: 'Status', f: (x) => x.enabled ? pill('ok', 'Enabled') : pill('muted', 'Phase 2 / not configured') }], i)}
        <p class="small muted" style="margin-top:12px">Stripe and GA4 are switched on by setting STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / GA4_ID. GPS, fuel and RFID devices attach through the devices table.</p></div>`;
    }
    const tabs = [['general', 'Business'], ['rates', 'Rate table'], ['emails', 'Email templates'], ['checklists', 'Checklist templates'], ['users', 'Users'], ['integrations', 'Integrations']];
    page(req, res, 'Settings', html`<nav class="tabs">${tabs.map(([k, l]) => html`<a href="?tab=${k}" ${raw(k === tab ? 'aria-current="page"' : '')}>${l}</a>`)}</nav>${body}`);
  });
  r.post('/settings', (req, res) => { for (const [k, v] of Object.entries(req.body)) h.run('UPDATE settings SET value=?, placeholder=0 WHERE key=? AND value<>?', String(v), k, String(v)); S.audit(h, req.user, 'update', 'settings', null, req.body); flash(res, 'Settings saved.'); res.redirect('/admin/settings'); });
  r.post('/settings/rates', (req, res) => {
    for (const x of h.all('SELECT * FROM rates')) {
      const rate = Number(req.body['rate_' + x.id]), mn = Number(req.body['min_' + x.id]), mx = Number(req.body['max_' + x.id]);
      if (rate > 0 && mx > mn && (rate !== x.monthly_rate || mn !== x.min_len || mx !== x.max_len)) h.run('UPDATE rates SET monthly_rate=?, min_len=?, max_len=?, placeholder=0 WHERE id=?', rate, mn, mx, x.id);
    }
    S.audit(h, req.user, 'update', 'rates', null); flash(res, 'Rates saved.'); res.redirect('/admin/settings?tab=rates');
  });
  r.post('/settings/emails/:key', (req, res) => { h.run('UPDATE email_templates SET subject=?, body=? WHERE key=?', req.body.subject, req.body.body, req.params.key); flash(res, 'Template saved.'); res.redirect('/admin/settings?tab=emails'); });
  r.post('/settings/checklists/:id', (req, res) => {
    const items = String(req.body.items || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[1])
      .map(([section, lbl, req1, photo]) => ({ section, label: lbl, required: /^y/i.test(req1 || 'yes'), photo: /^y/i.test(photo || '') }));
    if (!items.length) return back(req, res, 'Add at least one item.');
    h.run('UPDATE checklist_templates SET items=? WHERE id=?', JSON.stringify(items), req.params.id);
    S.audit(h, req.user, 'update', 'checklist_template', Number(req.params.id)); flash(res, 'Template saved.'); res.redirect('/admin/settings?tab=checklists');
  });
  r.post('/settings/users', (req, res) => {
    const b = req.body;
    if (!['office', 'yard', 'finance', 'admin'].includes(b.role) || (b.password || '').length < 8) return back(req, res, 'Choose a role and a password of 8+ characters.');
    try { h.run('INSERT INTO users (email,name,role,password_hash) VALUES (?,?,?,?)', b.email.toLowerCase(), b.name, b.role, C.hashPassword(b.password)); } catch { return back(req, res, 'That email already has an account.'); }
    S.audit(h, req.user, 'create', 'user', null, { email: b.email, role: b.role }); flash(res, 'User added.'); res.redirect('/admin/settings?tab=users');
  });

  // ======================= OUTBOX & AUDIT =======================
  r.get('/outbox', (req, res) => {
    const rows = h.all('SELECT * FROM outbox ORDER BY id DESC LIMIT 200');
    page(req, res, 'Outbox', html`<p class="muted">Every email and notification the system sends. In this demo nothing leaves the server; connect an email provider to deliver them.</p>
      <div class="card">${table([{ h: 'When', f: (x) => dt(x.created_at) }, { h: 'Channel', k: 'channel' }, { h: 'To', k: 'recipient' }, { h: 'Subject', f: (x) => html`<a href="/admin/outbox/${x.id}">${x.subject}</a>` }, { h: 'Template', k: 'template' }], rows)}</div>`);
  });
  r.get('/outbox/:id', (req, res, next) => {
    const x = h.get('SELECT * FROM outbox WHERE id=?', req.params.id);
    if (!x) return next();
    const linked = String(x.body || '').replace(/(https?:\/\/\S+)/g, '\u0000$1\u0000').split('\u0000');
    page(req, res, x.subject, html`<div class="card" style="max-width:720px"><dl class="kv"><dt>To</dt><dd>${x.recipient}</dd><dt>Sent</dt><dd>${dt(x.created_at)}</dd></dl>
      <pre style="white-space:pre-wrap;font:inherit;margin-top:16px;background:var(--surface-2);padding:16px;border-radius:8px">${linked.map((p) => /^https?:\/\//.test(p) ? html`<a href="${p}">${p}</a>` : p)}</pre></div>`, { active: '/admin/outbox' });
  });
  r.get('/audit', (req, res) => {
    const ent = req.query.entity || '';
    const rows = h.all(`SELECT * FROM audit_log ${ent ? 'WHERE entity=?' : ''} ORDER BY id DESC LIMIT 300`, ...(ent ? [ent] : []));
    const ents = h.all('SELECT DISTINCT entity FROM audit_log ORDER BY entity').map((x) => x.entity);
    page(req, res, 'Audit log', html`<form class="filters"><select name="entity" aria-label="Entity"><option value="">Everything</option>${ents.map((e) => html`<option ${raw(e === ent ? 'selected' : '')}>${e}</option>`)}</select><button class="btn btn-brand btn-sm">Filter</button></form>
      <div class="card">${table([{ h: 'When', f: (a) => dt(a.at) }, { h: 'Who', k: 'user_name' }, { h: 'Action', k: 'action' }, { h: 'Entity', f: (a) => `${a.entity}${a.entity_id ? ' #' + a.entity_id : ''}` }, { h: 'Reason', k: 'reason' }, { h: 'Detail', f: (a) => html`<span class="small" style="word-break:break-all">${(a.detail || '').slice(0, 200)}</span>` }], rows)}</div>`);
  });
};

function renderInvoice(h, id, biz) {
  const i = h.get('SELECT i.*, c.name cname, c.email, c.address, c.billing_address, c.abn cabn, c.company FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=?', id);
  if (!i) return null;
  const lines = h.all('SELECT * FROM invoice_lines WHERE invoice_id=?', id);
  return html`<div class="card" style="max-width:860px">
    <div style="display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid var(--brand);padding-bottom:14px;margin-bottom:18px;flex-wrap:wrap">
      <div><img src="/static/img/logo-240.png" alt="Cockatoo Marine" style="height:64px;width:auto"><p class="small" style="margin-top:8px">${biz.name}<br>ABN ${biz.abn}<br>${biz.address}<br>${biz.phone}</p></div>
      <div style="text-align:right"><div style="font-size:1.6rem;font-weight:700;color:var(--brand)">Tax invoice</div><div><b>${i.number}</b> ${pill(i.status)}</div><div class="small">Issued ${d(i.issue_date)}<br>Due ${d(i.due_date)}</div></div></div>
    <p><b>Bill to</b><br>${i.company || i.cname}<br>${i.billing_address || i.address || ''}${i.cabn ? html`<br>ABN ${i.cabn}` : ''}</p>
    <table class="tbl"><thead><tr><th>Description</th><th>Billing</th><th class="r">Qty</th><th class="r">Unit (incl. GST)</th><th class="r">GST</th><th class="r">Amount</th></tr></thead>
      <tbody>${lines.map((l) => html`<tr><td>${l.description}</td><td>${label(l.billing)}</td><td class="r num">${l.qty}</td><td class="r num">${money(l.unit_inc)}</td><td class="r num">${money(l.gst)}</td><td class="r num">${money(l.amount_inc)}</td></tr>`)}</tbody></table>
    <div style="margin-left:auto;max-width:300px;margin-top:14px"><dl class="kv" style="grid-template-columns:1fr auto"><dt>Subtotal (ex GST)</dt><dd class="num" style="text-align:right">${money(i.subtotal_ex)}</dd><dt>GST (10%)</dt><dd class="num" style="text-align:right">${money(i.gst)}</dd>
      <dt><b>Total (incl. GST)</b></dt><dd class="num" style="text-align:right"><b>${money(i.total)}</b></dd><dt>Paid</dt><dd class="num" style="text-align:right">${money(i.paid)}</dd><dt><b>Balance due</b></dt><dd class="num" style="text-align:right"><b>${money(i.total - i.paid)}</b></dd></dl></div>
    <p class="small muted" style="margin-top:18px">Pay by bank transfer to ${h.setting('bank_details')} using reference ${i.number}, or pay by card in your customer portal. Storage is billed monthly in advance; extras are invoiced in arrears.</p></div>`;
}
module.exports.renderInvoice = renderInvoice;
module.exports.parseCsv = parseCsv;
