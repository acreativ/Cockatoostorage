// Admin › Website: edit pages (rich text), home-page blocks, menus, media and revisions — a small WordPress-style CMS.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const S = require('../services');
const CMS = require('../cms');
const { html, raw, pill, table, field, dt, label } = require('../ui');

const STOCK = ['hero-cruiser', 'sailboat', 'yacht-moored', 'superyacht', 'aerial-boat', 'sydney-opera'].map((n) => [`/static/img/stock/${n}.jpg`, `Stock: ${n.replace(/-/g, ' ')}`]);
const QUILL = '2.0.3';

module.exports = (r, h, { page, back, flash, can }) => {
  const mediaDir = path.join(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'), 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const mediaUpload = multer({
    storage: multer.diskStorage({ destination: mediaDir, filename: (req, f, cb) => cb(null, crypto.randomBytes(8).toString('hex') + (path.extname(f.originalname).toLowerCase().match(/^\.(jpe?g|png|webp|gif)$/)?.[0] || '.jpg')) }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, f, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(f.mimetype)),
  });
  const mediaList = () => fs.readdirSync(mediaDir).filter((f) => !f.startsWith('.')).map((f) => ({ f, url: `/media/${f}`, at: fs.statSync(path.join(mediaDir, f)).mtime }))
    .sort((a, b) => b.at - a.at);
  const tabs = (active) => html`<nav class="tabs">${[['pages', 'Pages', '/admin/website'], ['home', 'Home page', '/admin/website/home'], ['media', 'Media', '/admin/website/media']]
    .map(([k, l, href]) => html`<a href="${href}" ${raw(k === active ? 'aria-current="page"' : '')}>${l}</a>`)}</nav>`;
  const opts = { active: '/admin/website' };

  // ---------- Pages list ----------
  r.get('/website', (req, res) => {
    const rows = h.all('SELECT * FROM pages ORDER BY menu=\'none\', sort_order, h1');
    page(req, res, 'Website', html`${tabs('pages')}
      <div class="card">${table([
        { h: 'Page', f: (p) => html`<a href="/admin/website/pages/${p.id}"><b>${p.h1 || p.title}</b></a><div class="small muted">/${p.slug}</div>` },
        { h: 'Template', f: (p) => label(p.template) },
        { h: 'Menu', f: (p) => p.menu === 'none' ? html`<span class="muted">—</span>` : html`${label(p.menu)} <span class="small muted">#${p.sort_order}</span>` },
        { h: 'Status', f: (p) => p.status === 'published' ? pill('ok', 'Published') : pill('warn', 'Draft') },
        { h: 'Last edited', f: (p) => html`${dt(p.updated_at)} <span class="small muted">${p.updated_by || ''}</span>` },
        { h: '', f: (p) => html`<a class="btn btn-outline btn-sm" href="/admin/website/pages/${p.id}">Edit</a> <a class="btn btn-outline btn-sm" href="/${p.slug}" target="_blank">View</a>` },
      ], rows)}</div>`, { ...opts, actions: html`<a class="btn btn-brand btn-sm" href="/admin/website/pages/new">Add page</a>` });
  });

  // ---------- Page editor ----------
  const editor = (req, res, p, revisions = []) => {
    const isNew = !p.id;
    const images = [['', 'No hero image'], ...STOCK, ...mediaList().map((m) => [m.url, `Uploaded: ${m.f}`])];
    page(req, res, isNew ? 'Add page' : `Edit: ${p.h1 || p.title}`, html`
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/quill@${QUILL}/dist/quill.snow.css">
      <form method="post" action="/admin/website/pages/${isNew ? 'new' : p.id}" id="pageform" class="cms-edit">
        <div class="cms-main">
          <div class="card">
            ${field('h1', 'Page heading', { value: p.h1, required: true, attrs: 'class="cms-title" placeholder="Add heading"' })}
            ${field('lead', 'Intro text (shown under the heading)', { type: 'textarea', rows: 2, value: p.lead })}
            <div class="field"><span class="label">Content</span>
              <div id="editor">${raw(p.body || '')}</div>
              <textarea name="body" id="body" hidden></textarea></div>
          </div>
          ${!isNew && revisions.length ? html`<div class="card"><h2>Revisions</h2>${table([
            { h: 'Saved', f: (v) => dt(v.saved_at) }, { h: 'By', k: 'saved_by' },
            { h: '', f: (v) => html`<button class="btn btn-outline btn-sm" form="restore${v.id}" data-confirm="Restore this version? The current version is kept as a revision.">Restore</button>` }], revisions)}
</div>` : ''}
        </div>
        <aside class="cms-side">
          <div class="card"><h2>Publish</h2>
            ${field('status', 'Status', { options: [['published', 'Published'], ['draft', 'Draft (hidden from visitors)']], value: p.status || 'draft' })}
            <button class="btn btn-primary btn-block">${isNew ? 'Publish page' : 'Update'}</button>
            ${!isNew ? html`<a class="btn btn-outline btn-block" style="margin-top:8px" href="/${p.slug}" target="_blank">${p.status === 'published' ? 'View page' : 'Preview draft'}</a>` : ''}
            ${!isNew && p.updated_at ? html`<p class="small muted" style="margin:10px 0 0">Last edited ${dt(p.updated_at)} by ${p.updated_by}</p>` : ''}
          </div>
          <div class="card"><h2>Page settings</h2>
            ${field('slug', 'Web address', { value: p.slug, hint: `cockatoostorage.vercel.app/${p.slug || 'your-page'}`, attrs: 'pattern="[a-z0-9-]+" placeholder="leave blank to create from the heading"' })}
            ${field('template', 'Template', { options: [['standard', 'Standard page'], ['storage', 'Dry boat storage (quote box + price tables)'], ['enquiry', 'Enquiry page']], value: p.template })}
            ${field('service', 'Enquiry form', { options: [['', 'No enquiry form'], ['storage', 'Dry boat storage'], ['antifoul', 'Antifoul & servicing'], ['marina', 'Marina berth'], ['commercial', 'Commercial berth'], ['barging', 'Barging'], ['events', 'Events'], ['other', 'General']], value: p.service || '' })}
            ${field('image', 'Hero image', { options: images, value: p.image || '' })}
            <p class="small"><a href="/admin/website/media">Upload a new image</a></p>
          </div>
          <div class="card"><h2>Menu</h2>
            ${field('menu', 'Show in', { options: [['none', 'Not in a menu'], ['header', 'Header menu'], ['footer', 'Footer menu'], ['both', 'Header and footer']], value: p.menu || 'none' })}
            ${field('menu_label', 'Menu label', { value: p.menu_label, attrs: 'placeholder="defaults to the heading"' })}
            ${field('sort_order', 'Order (lower shows first)', { type: 'number', value: p.sort_order ?? 100 })}
          </div>
          <div class="card"><h2>Search engines</h2>
            ${field('title', 'SEO title', { value: p.title, attrs: 'maxlength="70" data-count'.replace('data-count', 'data-count="60"') })}
            ${field('description', 'Meta description', { type: 'textarea', rows: 3, value: p.description, attrs: 'maxlength="200" data-count="160"' })}
          </div>
          ${!isNew && can(req.user, 'admin') ? html`<button class="btn btn-outline btn-block" form="delpage" data-confirm="Delete this page? This can’t be undone.">Delete page</button>` : ''}
        </aside>
      </form>
      ${!isNew ? html`<form id="delpage" method="post" action="/admin/website/pages/${p.id}/delete"></form>` : ''}
      ${revisions.map((v) => html`<form id="restore${v.id}" method="post" action="/admin/website/pages/${p.id}/restore/${v.id}"></form>`)}
      <script src="https://cdn.jsdelivr.net/npm/quill@${QUILL}/dist/quill.js"></script>
      <script>
        (function () {
          const quill = new Quill('#editor', { theme: 'snow', placeholder: 'Write the page content…', modules: { toolbar: { container: [[{ header: [2, 3, false] }], ['bold', 'italic', 'underline', 'link'], [{ list: 'ordered' }, { list: 'bullet' }], ['blockquote'], [{ align: [] }], ['image', 'clean']],
            handlers: { image() {
              const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
              input.onchange = async () => {
                const fd = new FormData(); fd.append('file', input.files[0]);
                const r = await fetch('/admin/website/media?json=1', { method: 'POST', body: fd }); const j = await r.json();
                if (j.url) { const at = (quill.getSelection(true) || { index: quill.getLength() }).index; quill.insertEmbed(at, 'image', j.url, 'user'); } else alert(j.error || 'Upload failed');
              };
              input.click();
            } } } } });
          const form = document.getElementById('pageform');
          form.addEventListener('submit', () => { document.getElementById('body').value = quill.getLength() > 1 ? quill.root.innerHTML : ''; });
          document.querySelectorAll('[data-count]').forEach((el) => {
            const out = document.createElement('span'); out.className = 'hint'; el.after(out);
            const upd = () => { const n = el.value.length, max = Number(el.dataset.count); out.textContent = n + ' / ' + max + ' characters' + (n > max ? ' – may be cut off in Google' : ''); };
            el.addEventListener('input', upd); upd();
          });
        })();
      </script>`, opts);
  };

  r.get('/website/pages/new', (req, res) => editor(req, res, { status: 'draft', template: 'standard', menu: 'none', sort_order: 100 }));
  r.get('/website/pages/:id', (req, res, next) => {
    const p = h.get('SELECT * FROM pages WHERE id=?', req.params.id);
    if (!p) return next();
    editor(req, res, p, h.all('SELECT id, saved_by, saved_at FROM page_revisions WHERE page_id=? ORDER BY id DESC LIMIT 20', p.id));
  });

  const FIELDS = ['slug', 'title', 'description', 'h1', 'lead', 'image', 'body', 'template', 'service', 'menu', 'menu_label', 'sort_order', 'status'];
  function clean(b) {
    const v = {
      h1: String(b.h1 || '').trim().slice(0, 160), lead: String(b.lead || '').trim().slice(0, 600),
      title: String(b.title || '').trim().slice(0, 120), description: String(b.description || '').trim().slice(0, 300),
      body: CMS.sanitize(b.body).slice(0, 200000), slug: CMS.slugify(b.slug || b.h1),
      template: ['standard', 'storage', 'enquiry'].includes(b.template) ? b.template : 'standard',
      service: ['storage', 'antifoul', 'marina', 'commercial', 'barging', 'events', 'other'].includes(b.service) ? b.service : null,
      menu: ['header', 'footer', 'both', 'none'].includes(b.menu) ? b.menu : 'none',
      menu_label: String(b.menu_label || '').trim().slice(0, 40) || null, sort_order: Number.parseInt(b.sort_order, 10) || 100,
      status: b.status === 'published' ? 'published' : 'draft',
      image: /^\/(static\/img\/stock|media)\/[\w.-]+$/.test(b.image || '') ? b.image : null,
    };
    if (!v.h1) throw new Error('Give the page a heading.');
    if (!v.slug) throw new Error('Give the page a web address.');
    if (CMS.RESERVED.has(v.slug)) throw new Error(`“${v.slug}” is used by the system. Choose another web address.`);
    if (!v.title) v.title = `${v.h1} | Cockatoo Marine`;
    return v;
  }
  const snapshot = (p, user) => h.run('INSERT INTO page_revisions (page_id,snapshot,saved_by) VALUES (?,?,?)', p.id, JSON.stringify(p), user.name);

  r.post('/website/pages/new', (req, res) => {
    try {
      const v = clean(req.body);
      if (h.get('SELECT 1 FROM pages WHERE slug=?', v.slug)) throw new Error('Another page already uses that web address.');
      const x = h.run(`INSERT INTO pages (${FIELDS},updated_by,updated_at) VALUES (${FIELDS.map(() => '?')},?,?)`, ...FIELDS.map((k) => v[k]), req.user.name, new Date().toISOString());
      S.audit(h, req.user, 'create', 'page', Number(x.lastInsertRowid), { slug: v.slug, status: v.status });
      flash(res, v.status === 'published' ? 'Page published.' : 'Draft saved.'); res.redirect('/admin/website/pages/' + x.lastInsertRowid);
    } catch (e) { back(req, res, e.message); }
  });
  r.post('/website/pages/:id', (req, res) => {
    const p = h.get('SELECT * FROM pages WHERE id=?', req.params.id);
    if (!p) return back(req, res, 'Page not found.');
    try {
      const v = clean(req.body);
      if (h.get('SELECT 1 FROM pages WHERE slug=? AND id<>?', v.slug, p.id)) throw new Error('Another page already uses that web address.');
      h.tx(() => {
        snapshot(p, req.user);
        h.run(`UPDATE pages SET ${FIELDS.map((k) => k + '=?')}, updated_by=?, updated_at=? WHERE id=?`, ...FIELDS.map((k) => v[k]), req.user.name, new Date().toISOString(), p.id);
      });
      S.audit(h, req.user, 'update', 'page', p.id, { slug: v.slug, status: v.status });
      flash(res, 'Page updated.'); res.redirect('/admin/website/pages/' + p.id);
    } catch (e) { back(req, res, e.message); }
  });
  r.post('/website/pages/:id/restore/:rid', (req, res) => {
    const p = h.get('SELECT * FROM pages WHERE id=?', req.params.id);
    const rev = h.get('SELECT * FROM page_revisions WHERE id=? AND page_id=?', req.params.rid, req.params.id);
    if (!p || !rev) return back(req, res, 'Revision not found.');
    const old = JSON.parse(rev.snapshot);
    h.tx(() => {
      snapshot(p, req.user);
      h.run(`UPDATE pages SET ${FIELDS.map((k) => k + '=?')}, updated_by=?, updated_at=? WHERE id=?`, ...FIELDS.map((k) => old[k] ?? null), req.user.name, new Date().toISOString(), p.id);
    });
    S.audit(h, req.user, 'restore', 'page', p.id, { revision: rev.id });
    flash(res, `Restored the version from ${dt(rev.saved_at)}.`); res.redirect('/admin/website/pages/' + p.id);
  });
  r.post('/website/pages/:id/delete', (req, res) => {
    if (!can(req.user, 'admin')) return back(req, res, 'Only admins can delete pages.');
    const p = h.get('SELECT * FROM pages WHERE id=?', req.params.id);
    if (!p) return back(req, res, 'Page not found.');
    h.run('DELETE FROM page_revisions WHERE page_id=?', p.id);
    h.run('DELETE FROM pages WHERE id=?', p.id);
    S.audit(h, req.user, 'delete', 'page', p.id, { slug: p.slug, h1: p.h1 });
    flash(res, `Deleted “${p.h1}”.`); res.redirect('/admin/website');
  });

  // ---------- Home page blocks ----------
  r.get('/website/home', (req, res) => {
    const c = CMS.home(h);
    const links = h.all(`SELECT slug, h1 FROM pages WHERE status='published' ORDER BY h1`).map((p) => ['/' + p.slug, `${p.h1} (/${p.slug})`]);
    page(req, res, 'Website', html`${tabs('home')}
      <form method="post" action="/admin/website/home" style="max-width:860px">
        <div class="card"><h2>Hero (top of the page)</h2>
          ${field('hero_title', 'Headline', { value: c.hero_title, required: true })}
          ${field('hero_lead', 'Text under the headline', { type: 'textarea', rows: 2, value: c.hero_lead })}</div>
        <div class="card"><h2>Notification banner</h2>
          <label class="check" style="margin-bottom:12px"><input type="checkbox" name="promo_enabled" value="1" ${raw(c.promo_enabled === '1' ? 'checked' : '')}> Show the banner on the home page</label>
          ${field('promo_text', 'Banner text', { value: c.promo_text, hint: 'Shown in capitals, e.g. Winter specials | 10% off antifouling | Click here' })}
          ${field('promo_link', 'Links to', { options: [...links, ['/book', 'Storage quote (/book)'], ['/enquiry', 'Enquiry (/enquiry)']], value: c.promo_link })}
          <div class="promo" style="border-radius:8px;margin-top:6px"><span class="promo-btn" id="promoPreview">${c.promo_text}</span></div></div>
        <div class="card"><h2>Intro section</h2>
          ${field('intro_title', 'Heading (the page’s main H1)', { value: c.intro_title, required: true })}
          ${field('intro_text', 'Paragraph', { type: 'textarea', rows: 4, value: c.intro_text })}</div>
        <div style="display:flex;gap:8px"><button class="btn btn-primary">Save home page</button><a class="btn btn-outline" href="/" target="_blank">View home page</a></div>
      </form>
      <script>document.getElementById('f_promo_text').addEventListener('input', (e) => { document.getElementById('promoPreview').textContent = e.target.value; });</script>`, opts);
  });
  r.post('/website/home', (req, res) => {
    const b = req.body;
    const vals = {
      hero_title: String(b.hero_title || '').trim().slice(0, 160), hero_lead: String(b.hero_lead || '').trim().slice(0, 400),
      promo_enabled: b.promo_enabled ? '1' : '0', promo_text: String(b.promo_text || '').trim().slice(0, 120),
      promo_link: /^\/[a-z0-9-]*$/.test(b.promo_link || '') ? b.promo_link : '/',
      intro_title: String(b.intro_title || '').trim().slice(0, 200), intro_text: String(b.intro_text || '').trim().slice(0, 1200),
    };
    if (!vals.hero_title || !vals.intro_title) return back(req, res, 'The hero headline and intro heading can’t be empty.');
    const before = CMS.home(h);
    for (const [k, v] of Object.entries(vals)) h.run('INSERT INTO site_content (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
    S.audit(h, req.user, 'update', 'home_page', null, { before, after: vals });
    flash(res, 'Home page saved.'); res.redirect('/admin/website/home');
  });

  // ---------- Media library ----------
  r.get('/website/media', (req, res) => {
    const files = mediaList();
    page(req, res, 'Website', html`${tabs('media')}
      <form class="card" method="post" action="/admin/website/media" enctype="multipart/form-data" style="max-width:640px">
        <h2>Upload an image</h2>
        <div class="field"><label for="file">JPG, PNG, WebP or GIF, up to 8 MB</label><input id="file" type="file" name="file" accept="image/*" required></div>
        <button class="btn btn-brand">Upload</button></form>
      ${files.length ? html`<div class="media-grid">${files.map((m) => html`<figure class="card"><img src="${m.url}" alt="" loading="lazy"><figcaption class="small"><code>${m.url}</code><br><span class="muted">${dt(m.at.toISOString())}</span></figcaption></figure>`)}</div>`
        : html`<div class="empty">No uploads yet. Stock photos are always available as hero images.</div>`}`, opts);
  });
  r.post('/website/media', mediaUpload.single('file'), (req, res) => {
    if (!req.file) return req.query.json ? res.status(400).json({ error: 'Choose a JPG, PNG, WebP or GIF under 8 MB.' }) : back(req, res, 'Choose a JPG, PNG, WebP or GIF under 8 MB.');
    S.audit(h, req.user, 'upload', 'media', null, { file: req.file.filename });
    if (req.query.json) return res.json({ url: `/media/${req.file.filename}` });
    flash(res, 'Image uploaded. Pick it as a hero image in any page’s settings.'); res.redirect('/admin/website/media');
  });
};
