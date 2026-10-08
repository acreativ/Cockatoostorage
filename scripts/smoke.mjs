// Crawls every page as each role and reports non-200s. Run with the server on PORT.
const base = process.env.BASE || 'http://localhost:3000';
async function login(email) {
  const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `email=${encodeURIComponent(email)}&password=demo1234` });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const pages = ['/admin', '/admin/calendar', '/admin/calendar?days=90', '/admin/bays', '/admin/bookings', '/admin/bookings/new', '/admin/bookings/new?customer=1', '/admin/bookings/1', '/admin/bookings/7', '/admin/leads', '/admin/leads/new', '/admin/leads/1', '/admin/leads/7',
  '/admin/customers', '/admin/customers/new', ...['overview', 'bookings', 'billing', 'activity', 'comms', 'edit'].map((t) => '/admin/customers/1?tab=' + t), '/admin/boats', '/admin/boats/new', '/admin/boats/1', '/admin/boats/1/sheet',
  '/admin/checklists', '/admin/checklists/new', '/admin/checklists/new?type=release&boat=3', '/admin/checklists/new?type=return&boat=1', '/admin/checklists/1', '/admin/checklists/3', '/admin/checklists/templates', '/admin/releases',
  '/admin/lifts', '/admin/services', '/admin/services/new', '/admin/services/1', '/admin/maintenance', '/admin/maintenance/new', '/admin/maintenance/1', '/admin/invoices', '/admin/invoices/1', '/admin/expenses',
  '/admin/reports', '/admin/reports?tab=pnl', '/admin/reports?tab=aging', '/admin/reports/export/invoices.csv', '/admin/reports/export/pnl.csv', '/admin/watchlist', '/admin/import', ...['general', 'rates', 'emails', 'checklists', 'users', 'integrations'].map((t) => '/admin/settings?tab=' + t),
  '/admin/outbox', '/admin/outbox/1', '/admin/audit'];
const portal = ['/portal', '/portal/lifts', '/portal/invoices', '/portal/invoices/1', '/portal/checklists', '/portal/checklists/1', '/portal/boats/1/sheet'];
const pub = ['/', '/book', '/dry-boat-storage', '/service-antifoul', '/marina', '/commercial-berths', '/barging', '/events', '/enquiry', '/about', '/employment', '/terms-and-conditions', '/delivery-information', '/login', '/robots.txt', '/sitemap.xml', '/api/weather', '/q/nope', '/nope'];
let bad = 0;
const hit = async (u, cookie, who) => { const r = await fetch(base + u, { headers: { cookie: cookie || '' }, redirect: 'manual' }); const t = await r.text(); const err = /Something went wrong|Not allowed/.test(t);
  if ((r.status !== 200 && !(u === '/nope' && r.status === 404)) || (err && who === 'admin')) { bad++; console.log(who, r.status, u, err ? 'ERRPAGE' : '', r.headers.get('location') || ''); } };
for (const u of pub) await hit(u, '', 'public');
const admin = await login('admin@cockatoo.test');
for (const u of pages) await hit(u, admin, 'admin');
for (const role of ['office', 'yard', 'finance']) { const c = await login(role + '@cockatoo.test'); for (const u of ['/admin', '/admin/calendar', '/admin/lifts', '/admin/invoices', '/admin/watchlist']) { const r = await fetch(base + u, { headers: { cookie: c } }); const t = await r.text(); console.log(role, u, r.status, /Not allowed/.test(t) ? 'denied' : 'ok'); } }
const cust = await login('sam.taylor@example.com');
for (const u of portal) await hit(u, cust, 'customer');
const r = await fetch(base + '/admin', { headers: { cookie: cust }, redirect: 'manual' }); console.log('customer -> /admin', r.status, r.headers.get('location'));
console.log(bad ? `${bad} problems` : 'ALL OK');
