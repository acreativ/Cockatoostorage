const test = require('node:test');
const assert = require('node:assert/strict');
const CMS = require('../src/cms');
const { seed } = require('../src/seed');

test('sanitizer keeps formatting and strips scripts, handlers and javascript: links', () => {
  const out = CMS.sanitize('<h2 onclick="x()">Hi</h2><p class="ql-align-center">A <strong>b</strong> <a href="javascript:alert(1)">bad</a> <a href="/marina" target="_blank">ok</a></p><script>alert(1)</script><iframe src="https://evil"></iframe><img src="/media/a.jpg" onerror="x">');
  assert.equal(out, '<h2>Hi</h2><p class="ql-align-center">A <strong>b</strong> <a>bad</a> <a href="/marina" target="_blank" rel="noopener">ok</a></p><img src="/media/a.jpg">');
});
test('slugs are clean and system routes are reserved', () => {
  assert.equal(CMS.slugify('  Winter Specials 2026! '), 'winter-specials-2026');
  assert.ok(CMS.RESERVED.has('admin') && CMS.RESERVED.has('book'));
});
test('built-in pages and home blocks are imported once, with menus in order', () => {
  const h = seed(':memory:');
  CMS.ensure(h); CMS.ensure(h);
  assert.equal(h.get('SELECT COUNT(*) n FROM pages').n, Object.keys(require('../src/pages')).length);
  const m = CMS.menus(h);
  assert.deepEqual(m.header.map((x) => x.slug), ['service-antifoul', 'dry-boat-storage', 'marina', 'commercial-berths', 'barging', 'events', 'enquiry']);
  assert.ok(m.footer.some((x) => x.slug === 'terms-and-conditions') && m.footer.some((x) => x.slug === 'events'));
  assert.equal(CMS.home(h).promo_link, '/service-antifoul');
});
