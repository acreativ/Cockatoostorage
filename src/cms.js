// Website content management: pages, home-page blocks, revisions and an HTML sanitizer for the rich-text editor.
const PAGES = require('./pages');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT, description TEXT, h1 TEXT, lead TEXT, image TEXT,
  body TEXT, template TEXT DEFAULT 'standard' CHECK (template IN ('standard','storage','enquiry')), service TEXT,
  menu TEXT DEFAULT 'none' CHECK (menu IN ('header','footer','both','none')), menu_label TEXT, sort_order INTEGER DEFAULT 100,
  status TEXT DEFAULT 'published' CHECK (status IN ('published','draft')), updated_by TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS page_revisions (
  id INTEGER PRIMARY KEY, page_id INTEGER, snapshot TEXT, saved_by TEXT, saved_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS site_content (key TEXT PRIMARY KEY, value TEXT);
`;

const HOME_DEFAULTS = {
  hero_title: 'Dry boat storage on Sydney Harbour, from $547 a month',
  hero_lead: 'Keep your boat out of the water on Cockatoo Island. Choose a launch package, pick annual or monthly, and book your bay online in minutes.',
  promo_enabled: '1',
  promo_text: 'Winter specials | 10% off antifouling | Click here',
  promo_link: '/service-antifoul',
  intro_title: 'Cockatoo Marine, your convenient full service marine facility in Sydney Harbour',
  intro_text: 'Located on Cockatoo Island in the heart of Sydney Harbour, Cockatoo Marine offers dry boat storage, marina berths, and expert marine services. With a commitment to quality, convenience, and care, we’re here to make your boating life easier, safer, and more enjoyable.',
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Create tables and import the built-in pages the first time (or into an older database).
function ensure(h) {
  h.db.exec(SCHEMA);
  if (!h.get('SELECT 1 FROM pages LIMIT 1')) {
    let order = 10;
    for (const [path, p] of Object.entries(PAGES)) {
      const body = (p.sections || []).map(([hd, txt]) => `<h2>${esc(hd)}</h2><p>${esc(txt)}</p>`).join('');
      const menu = p.nav ? 'header' : p.footer ? 'footer' : 'none';
      h.run(`INSERT INTO pages (slug,title,description,h1,lead,image,body,template,service,menu,menu_label,sort_order,status,updated_by,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, path.slice(1), p.title, p.description, p.h1, p.lead, p.image || null, body,
        p.kind || 'standard', p.service || null, menu, p.nav || (typeof p.footer === 'string' ? p.footer : null), order, 'published', 'import', new Date().toISOString());
      order += 10;
    }
    // Events appears in both menus on the original site.
    h.run(`UPDATE pages SET menu='both' WHERE slug='events'`);
  }
  for (const [k, v] of Object.entries(HOME_DEFAULTS)) h.run('INSERT OR IGNORE INTO site_content (key,value) VALUES (?,?)', k, v);
}

function home(h) {
  return Object.fromEntries(h.all('SELECT key,value FROM site_content').map((r) => [r.key, r.value]));
}

function menus(h) {
  const rows = h.all(`SELECT slug, COALESCE(NULLIF(menu_label,''), h1) label, menu FROM pages WHERE status='published' AND menu<>'none' ORDER BY sort_order, id`);
  return { header: rows.filter((r) => r.menu === 'header' || r.menu === 'both'), footer: rows.filter((r) => r.menu === 'footer' || r.menu === 'both') };
}

// ---------- HTML sanitizer for editor content (allow-list) ----------
const ALLOWED = {
  p: [], br: [], h2: [], h3: [], h4: [], strong: [], b: [], em: [], i: [], u: [], s: [], blockquote: [],
  ul: [], ol: [], li: ['data-list'], a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'], span: [],
};
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|svg|math|template|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const safeUrl = (u) => /^(https?:|mailto:|tel:|\/(?!\/)|#)/i.test(u.trim()) && !/^\s*javascript:/i.test(u);

function sanitize(html) {
  return String(html || '')
    .replace(DROP_WITH_CONTENT, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, name, attrs) => {
      name = name.toLowerCase();
      if (!ALLOWED[name]) return '';
      if (tag.startsWith('</')) return `</${name}>`;
      const keep = [];
      const re = /([a-z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
      let m;
      while ((m = re.exec(attrs))) {
        const k = m[1].toLowerCase(), v = m[3] ?? m[4] ?? m[5] ?? '';
        if (k === 'class' && /^(ql-[a-z0-9-]+\s*)+$/.test(v)) { keep.push(`class="${esc(v)}"`); continue; }
        if (!ALLOWED[name].includes(k)) continue;
        if ((k === 'href' || k === 'src') && !safeUrl(v)) continue;
        if (k === 'target' && v !== '_blank') continue;
        keep.push(`${k}="${esc(v)}"`);
      }
      if (name === 'a' && keep.some((a) => a.startsWith('target='))) keep.push('rel="noopener"');
      return `<${name}${keep.length ? ' ' + keep.join(' ') : ''}>`;
    });
}

const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const RESERVED = new Set(['admin', 'portal', 'book', 'booking', 'checkout', 'login', 'logout', 'magic', 'api', 'static', 'uploads', 'media', 'q', 'webhooks', 'partials', 'enquiry-submit', 'robots.txt', 'sitemap.xml']);

module.exports = { ensure, home, menus, sanitize, slugify, RESERVED, HOME_DEFAULTS };
