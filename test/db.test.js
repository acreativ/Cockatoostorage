const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { seed } = require('../src/seed');
const C = require('../src/core');
const S = require('../src/services');
const { handleStripeEvent } = require('../src/routes/public');

const fresh = () => seed(':memory:');
const bay = (h, code) => h.get('SELECT id FROM bays WHERE code=?', code).id;
const far = (n) => C.addDays(C.todaySyd(), 400 + n);

test('database blocks double bookings on insert and update', () => {
  const h = fresh(); const b = bay(h, 'A05');
  S.createBooking(h, { bay_id: b, start_date: far(0), end_date: far(30), status: 'confirmed' });
  assert.throws(() => h.run(`INSERT INTO bookings (bay_id,start_date,end_date,status) VALUES (?,?,?,'pending')`, b, far(10), far(40)), /DOUBLE_BOOKING/);
  assert.throws(() => S.createBooking(h, { bay_id: b, start_date: far(29), end_date: far(31), status: 'confirmed' }), /already booked/);
  S.createBooking(h, { bay_id: b, start_date: far(30), end_date: far(60), status: 'confirmed' }); // touching ranges are fine
  const other = S.createBooking(h, { bay_id: bay(h, 'A06'), start_date: far(0), end_date: far(30), status: 'confirmed' });
  assert.throws(() => S.updateBooking(h, other.id, { bay_id: b }, null, 'move'), /double-book/);
});
test('cancelled bookings free the bay; maintenance blocks it', () => {
  const h = fresh(); const b = bay(h, 'A06');
  const x = S.createBooking(h, { bay_id: b, start_date: far(0), end_date: far(30), status: 'confirmed' });
  S.updateBooking(h, x.id, { status: 'cancelled' }, null, 'test');
  S.createBooking(h, { kind: 'maintenance', bay_id: b, start_date: far(0), end_date: far(5), status: 'maintenance' });
  assert.throws(() => S.createBooking(h, { bay_id: b, start_date: far(2), end_date: far(9), status: 'pending' }), /already booked/);
});
test('auto-assign picks a free bay that fits the boat', () => {
  const h = fresh();
  const bk = S.createBooking(h, { lengthM: 9.5, start_date: far(0), end_date: far(90), status: 'pending' });
  assert.ok(h.get('SELECT max_length_m m FROM bays WHERE id=?', bk.bay_id).m >= 9.5);
});
test('hold expiry: expired holds stop blocking and are marked expired', () => {
  const h = fresh(); const b = bay(h, 'A07');
  const hold = S.createBooking(h, { bay_id: b, start_date: far(0), end_date: far(30), status: 'hold', hold_expires_at: new Date(Date.now() + 60e3).toISOString() });
  assert.throws(() => S.createBooking(h, { bay_id: b, start_date: far(0), end_date: far(30), status: 'hold', hold_expires_at: new Date(Date.now() + 60e3).toISOString() }));
  h.run('UPDATE bookings SET hold_expires_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), hold.id);
  S.createBooking(h, { bay_id: b, start_date: far(0), end_date: far(30), status: 'pending' });
  assert.equal(S.expireHolds(h), 1);
  assert.equal(h.get('SELECT status FROM bookings WHERE id=?', hold.id).status, 'expired');
  assert.throws(() => S.confirmBooking(h, hold.id, { amount: 250, method: 'stripe', reference: 'late' }), /double-book/, 'late payment cannot steal the bay');
});
test('confirming a deposit creates paid deposit invoice, contract and email; idempotent', () => {
  const h = fresh();
  const cust = h.get(`SELECT * FROM customers WHERE email='morgan.chen@example.com'`);
  const bk = h.get(`SELECT * FROM bookings WHERE customer_id=? AND status='pending'`, cust.id);
  S.confirmBooking(h, bk.id, { amount: 250, method: 'bank_transfer', reference: 'NAB123' });
  S.confirmBooking(h, bk.id, { amount: 250, method: 'bank_transfer', reference: 'NAB123' });
  assert.equal(h.get('SELECT status FROM bookings WHERE id=?', bk.id).status, 'confirmed');
  assert.equal(h.get(`SELECT COUNT(*) n FROM invoices WHERE booking_id=? AND kind='deposit' AND status='paid'`, bk.id).n, 1);
  assert.equal(h.get('SELECT COUNT(*) n FROM contracts WHERE booking_id=?', bk.id).n, 1);
  assert.ok(h.get(`SELECT 1 FROM outbox WHERE dedupe_key=?`, 'confirm-' + bk.id));
  assert.equal(h.get('SELECT stage FROM leads WHERE id=?', bk.lead_id).stage, 'booked');
});
test('Stripe checkout.session.completed webhook confirms the booking', () => {
  const h = fresh(); const b = bay(h, 'A08');
  const cust = h.get('SELECT id FROM customers LIMIT 1');
  const hold = S.createBooking(h, { bay_id: b, customer_id: cust.id, start_date: far(0), end_date: far(365), status: 'hold', hold_expires_at: new Date(Date.now() + 60e3).toISOString(), package: 'standard', term: 'annual', monthly_rate: 547 });
  const out = handleStripeEvent(h, { type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 25000, payment_intent: 'pi_1', metadata: { booking_ref: hold.ref } } } });
  assert.deepEqual(out, { received: true });
  assert.equal(h.get('SELECT status FROM bookings WHERE id=?', hold.id).status, 'confirmed');
  assert.equal(h.get(`SELECT amount FROM payments WHERE reference='pi_1'`).amount, 250);
});
test('lift quota: third Standard lift in a month is a $30 extra, billed in arrears next month', () => {
  const h = fresh(); const b = bay(h, 'A04');
  const cust = h.get('SELECT id FROM customers LIMIT 1');
  const bk = S.createBooking(h, { bay_id: b, customer_id: cust.id, start_date: far(0), end_date: far(365), status: 'confirmed', package: 'standard', term: 'annual', monthly_rate: 547 });
  const day = (n) => C.addDays(far(0).slice(0, 8) + '01', n).slice(0, 10);
  const r1 = S.bookLift(h, { booking_id: bk.id, date: day(1), slot: '08:00' });
  const r2 = S.bookLift(h, { booking_id: bk.id, date: day(2), slot: '08:00' });
  const r3 = S.bookLift(h, { booking_id: bk.id, date: day(3), slot: '08:00' });
  assert.deepEqual([r1.extra, r2.extra, r3.extra], [false, false, true]);
  assert.throws(() => S.bookLift(h, { booking_id: bk.id, date: day(4), slot: '08:00', engine_flush: true }), /Unlimited/);
  const nextMonth = C.addMonths(day(0), 1).slice(0, 7);
  const inv = S.runMonthlyInvoicing(h, nextMonth).find((i) => i.booking_id === bk.id);
  const lines = h.all('SELECT * FROM invoice_lines WHERE invoice_id=?', inv.id);
  assert.deepEqual(lines.map((l) => [l.billing, l.amount_inc]), [['advance', 547], ['arrears', 30]]);
  assert.equal(inv.total, 577);
  assert.equal(S.runMonthlyInvoicing(h, nextMonth).filter((i) => i.booking_id === bk.id).length, 0, 'invoice run is idempotent');
});
test('lift slots respect capacity', () => {
  const h = fresh();
  h.run(`UPDATE settings SET value='1' WHERE key='lift_slot_capacity'`);
  const [b1, b2] = h.all(`SELECT id FROM bookings WHERE status IN ('active','confirmed') AND kind='storage' LIMIT 2`);
  const date = far(5);
  S.bookLift(h, { booking_id: b1.id, date, slot: '09:00' });
  assert.throws(() => S.bookLift(h, { booking_id: b2.id, date, slot: '09:00' }), /full/);
});
test('new leads matching the watchlist raise a staff alert only', () => {
  const h = fresh();
  const before = h.get('SELECT COUNT(*) n FROM watch_alerts').n;
  const id = S.createLead(h, { name: 'Someone Else', email: 'x@example.com', phone: '0499123456', service: 'storage' });
  assert.equal(h.get('SELECT COUNT(*) n FROM watch_alerts').n, before + 1);
  assert.equal(h.get('SELECT stage FROM leads WHERE id=?', id).stage, 'new', 'never auto-rejected');
});
