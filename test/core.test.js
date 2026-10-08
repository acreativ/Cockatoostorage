const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../src/core');

const rates = [
  { min_len: 0, max_len: 6, package: 'standard', term: 'annual', monthly_rate: 547, placeholder: 1 },
  { min_len: 6, max_len: 7.5, package: 'standard', term: 'annual', monthly_rate: 627, placeholder: 1 },
  { min_len: 0, max_len: 6, package: 'standard', term: 'monthly', monthly_rate: 607, placeholder: 1 },
  { min_len: 0, max_len: 6, package: 'unlimited', term: 'annual', monthly_rate: 697, placeholder: 0 },
];

test('pricing: picks the band by length, package and term', () => {
  assert.equal(C.quote(rates, { lengthM: 5.4, pkg: 'standard', term: 'annual' }).monthly, 547);
  assert.equal(C.quote(rates, { lengthM: 6, pkg: 'standard', term: 'annual' }).monthly, 547, 'band upper bound is inclusive');
  assert.equal(C.quote(rates, { lengthM: 6.01, pkg: 'standard', term: 'annual' }).monthly, 627);
  assert.equal(C.quote(rates, { lengthM: 5, pkg: 'unlimited', term: 'annual' }).monthly, 697);
});
test('pricing: annual = 12 months, monthly enforces 3-month minimum', () => {
  const a = C.quote(rates, { lengthM: 5, pkg: 'standard', term: 'annual' });
  assert.equal(a.months, 12); assert.equal(a.contractValue, 547 * 12);
  assert.equal(C.quote(rates, { lengthM: 5, pkg: 'standard', term: 'monthly' }).months, 3);
  assert.throws(() => C.quote(rates, { lengthM: 5, pkg: 'standard', term: 'monthly', months: 2 }), /3-month minimum/);
});
test('pricing: deposit fixed or percent; out-of-range length errors', () => {
  assert.equal(C.quote(rates, { lengthM: 5, pkg: 'standard', term: 'annual' }, { depositType: 'fixed', depositValue: 250 }).deposit, 250);
  assert.equal(C.quote(rates, { lengthM: 5, pkg: 'standard', term: 'annual' }, { depositType: 'percent', depositValue: 50 }).deposit, 273.5);
  assert.throws(() => C.quote(rates, { lengthM: 20, pkg: 'standard', term: 'annual' }), /quote this length individually/);
  assert.equal(C.ftToM(20), 6.1);
});
test('GST is 1/11 of GST-inclusive amounts', () => {
  assert.equal(C.gstOf(547), 49.73);
  assert.equal(C.gstOf(30), 2.73);
});
test('lift quota: Standard gets 2 included, Unlimited never extra', () => {
  assert.equal(C.isExtraLift('standard', 0), false);
  assert.equal(C.isExtraLift('standard', 1), false);
  assert.equal(C.isExtraLift('standard', 2), true);
  assert.equal(C.isExtraLift('unlimited', 50), false);
});
test('invoice: storage in advance, earlier extras in arrears, GST totals', () => {
  const inv = C.buildInvoice({ booking: { monthly_rate: 547, package: 'standard', term: 'annual' }, period: '2026-11',
    extras: [{ id: 1, date: '2026-10-20', description: 'Extra lift', amount_inc: 30 }, { id: 2, date: '2026-11-03', description: 'Extra lift', amount_inc: 30 }, { id: 3, date: '2026-09-01', amount_inc: 30, invoice_id: 9, description: 'x' }] });
  assert.equal(inv.lines.length, 2, 'only uninvoiced extras from before the period');
  assert.deepEqual(inv.lines.map((l) => l.billing), ['advance', 'arrears']);
  assert.equal(inv.total, 577); assert.equal(inv.gst, C.round2(49.73 + 2.73)); assert.equal(inv.subtotal_ex, C.round2(577 - inv.gst));
});
test('watchlist: exact on email/phone/rego/HIN, fuzzy on name, no false positives', () => {
  const w = [{ id: 1, name: 'Chris Fakename', email: 'chris.f@example.net', phone: '0499 123 456', rego: 'ZZ999N' }];
  assert.deepEqual(C.matchWatchlist(w, { name: 'Kris Fakename' })[0].reasons.length, 1);
  assert.ok(C.matchWatchlist(w, { phone: '+61 499 123 456' })[0].reasons.includes('phone'));
  assert.ok(C.matchWatchlist(w, { email: 'CHRIS.F@example.net' })[0].reasons.includes('email'));
  assert.ok(C.matchWatchlist(w, { rego: 'zz-999n' })[0].reasons.includes('rego'));
  assert.ok(C.matchWatchlist(w, { name: 'Fakename Chris' }).length, 'name order does not matter');
  assert.equal(C.matchWatchlist(w, { name: 'Sam Taylor', email: 'sam@example.com', phone: '0412 000 101' }).length, 0);
});
test('stripe webhook signature verification', () => {
  const secret = 'whsec_test', payload = '{"id":"evt_1"}', t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  assert.equal(C.verifyStripeSignature(payload, `t=${t},v1=${sig}`, secret), true);
  assert.equal(C.verifyStripeSignature(payload + 'x', `t=${t},v1=${sig}`, secret), false);
  assert.equal(C.verifyStripeSignature(payload, `t=${t - 1000},v1=${sig}`, secret), false, 'replay outside tolerance');
});
test('dates: month arithmetic clamps to month end', () => {
  assert.equal(C.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(C.addMonths('2026-10-08', 12), '2027-10-08');
});
