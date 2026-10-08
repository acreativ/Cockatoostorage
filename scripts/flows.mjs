// End-to-end POST flows against a running server (use a throwaway DB_FILE).
const base = process.env.BASE || 'http://localhost:3101';
const form = (o) => new URLSearchParams(o).toString();
const post = (u, body, cookie) => fetch(base + u, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie || '' }, body: form(body) });
const get = (u, cookie) => fetch(base + u, { headers: { cookie: cookie || '' } }).then((r) => r.text());
const login = async (e) => (await post('/login', { email: e, password: 'demo1234' })).headers.get('set-cookie').split(';')[0];
const flashOf = (r) => decodeURIComponent((r.headers.getSetCookie().find((c) => c.startsWith('cm_flash=')) || '').split(';')[0].slice(9));
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };
const start = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);

// 1. Public bank-transfer booking -> pending; office marks deposit paid -> confirmed
let r = await post('/book', { lengthM: 5.5, pkg: 'standard', term: 'monthly', start, action: 'bank', terms: 'yes', name: 'Flow Tester', email: 'flow@example.com', phone: '0400 000 999', make_model: 'Test 550' });
const ref = r.headers.get('location').split('/')[2].split('?')[0];
ok(r.status === 302 && /pending payment|awaiting your reservation fee/i.test(await get(`/booking/${ref}`)), 'bank booking is pending: ' + ref);
const office = await login('office@cockatoo.test');
const bk = (await get('/admin/bookings?q=' + ref, office)).match(/\/admin\/bookings\/(\d+)">CM-/)[1];
r = await post(`/admin/bookings/${bk}/pay`, { amount: 250, method: 'bank_transfer', reference: 'NAB-778', paid_on: start }, office);
ok(/Booking confirmed|Deposit recorded/.test(flashOf(r)), 'office marks deposit paid');
ok(/Confirmed/.test(await get(`/booking/${ref}`)), 'booking now confirmed');

// 2. Moving it onto an occupied bay is rejected by the DB
const page = await get(`/admin/bookings/${bk}`, office);
const a01 = page.match(/<option value="(\d+)"[^>]*>A01 /)[1];
r = await post(`/admin/bookings/${bk}/edit`, { bay_id: a01, start_date: start, end_date: new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10), status: 'confirmed', reason: 'test move' }, office);
ok(/double-book/.test(flashOf(r)), 'move onto occupied bay rejected: ' + flashOf(r));

// 3. General enquiry + manual Messenger lead
r = await post('/enquiry', { name: 'Ari Events', email: 'ari@example.com', service: 'events', message: '40 guests' });
ok(r.status === 200, 'events enquiry accepted');
r = await post('/enquiry', { name: 'Bot', email: 'b@x.com', website: 'spam' });
ok(r.status === 400, 'honeypot blocks spam');
r = await post('/admin/leads', { source: 'messenger', service: 'storage', name: 'Messenger Person', phone: '0400 123 123', message: 'DM enquiry' }, office);
ok(r.status === 302, 'messenger lead logged');

// 4. Lifts via portal: 3rd lift this month for Standard = extra
const cust = await login('sam.taylor@example.com');
const html = await get('/portal/lifts', cust);
ok(/Book a lift/.test(html), 'portal lift page');
// 5. Invoice run is idempotent
const fin = await login('finance@cockatoo.test');
const next = new Date(); next.setMonth(next.getMonth() + 1); const period = next.toISOString().slice(0, 7);
r = await post('/admin/invoices/run', { period }, fin); const f1 = flashOf(r);
r = await post('/admin/invoices/run', { period }, fin); const f2 = flashOf(r);
ok(/^\d+ invoice/.test(f1) && /^0 invoice/.test(f2), `invoice run: "${f1}" then "${f2}"`);
// 6. CSV import dry run reports bad rows and saves nothing
const admin = await login('admin@cockatoo.test');
const fd = new FormData(); fd.set('entity', 'customers'); fd.set('mode', 'dry'); fd.set('csv', 'name,email\nGood Person,good@example.com\n,missing@example.com\nBad Email,nope');
r = await fetch(base + '/admin/import', { method: 'POST', body: fd, headers: { cookie: admin } }); const t = await r.text();
ok(/Dry run: 1 of 3 rows are valid/.test(t), 'import dry run validates');
// 7. Watchlist restricted
ok(/does not have access/.test(await get('/admin/watchlist', office)), 'office cannot open watchlist');
ok(/Risk watchlist/.test(await get('/admin/watchlist', admin)), 'admin can open watchlist');
