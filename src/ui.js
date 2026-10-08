// Tiny HTML helpers for the admin. Every interpolated value goes through esc().
const C = require('./core');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Tagged template: interpolations are escaped unless wrapped with raw().
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const html = (strings, ...vals) => raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? fmt(vals[i]) : ''), ''));
const fmt = (v) => {
  // Guard against a forgotten `await`: a Promise would otherwise render as "[object Promise]".
  if (v && typeof v.then === 'function') throw new Error('A Promise was passed to html`` — a database call is missing await.');
  return fmtValue(v);
};
const fmtValue = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v === false || v == null ? '' : esc(v));

const STATUS = {
  hold: 'warn', pending: 'warn', confirmed: 'info', active: 'ok', maintenance: 'muted', completed: 'muted', cancelled: 'err', expired: 'err',
  new: 'info', contacted: 'info', quoted: 'warn', deposit_pending: 'warn', booked: 'ok', lost: 'err',
  issued: 'info', paid: 'ok', overdue: 'err', void: 'muted', draft: 'muted',
  available: 'ok', occupied: 'info', reserved: 'warn', out_of_service: 'err',
  booked_lift: 'info', done: 'ok', no_show: 'err', open: 'warn', in_progress: 'info', scheduled: 'info', invoiced: 'ok',
  pass: 'ok', fail: 'err', na: 'muted',
};
const label = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const pill = (s, text) => html`<span class="pill ${STATUS[s] || 'muted'}">${text ?? label(s)}</span>`;

function table(cols, rows, empty = 'Nothing here yet.') {
  if (!rows.length) return html`<div class="empty">${empty}</div>`;
  return html`<div class="tbl-wrap"><table class="tbl"><thead><tr>${cols.map((c) => html`<th class="${c.num ? 'r' : ''}">${c.h}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr>${cols.map((c) => html`<td class="${c.num ? 'r num' : ''}" data-h="${c.h}">${c.f ? c.f(r) : r[c.k]}</td>`)}</tr>`)}</tbody></table></div>`;
}

function field(name, lbl, { type = 'text', value = '', options, required, hint, attrs = '', rows } = {}) {
  const id = 'f_' + name;
  let input;
  if (options) input = html`<select id="${id}" name="${name}" ${raw(required ? 'required' : '')} ${raw(attrs)}>${options.map((o) => {
    const [v, l] = Array.isArray(o) ? o : [o, label(o)];
    return html`<option value="${v}" ${raw(String(v) === String(value ?? '') ? 'selected' : '')}>${l}</option>`;
  })}</select>`;
  else if (type === 'textarea') input = html`<textarea id="${id}" name="${name}" rows="${rows || 3}" ${raw(attrs)}>${value}</textarea>`;
  else input = html`<input id="${id}" name="${name}" type="${type}" value="${value}" ${raw(required ? 'required' : '')} ${raw(attrs)}>`;
  return html`<div class="field"><label for="${id}">${lbl}</label>${input}${hint ? html`<span class="hint">${hint}</span>` : ''}</div>`;
}

const money = (n) => C.aud(n);
const d = (s) => C.fmtDate(s);
const dt = (s) => C.fmtDateTime(s);

module.exports = { esc, raw, html, pill, table, field, money, d, dt, label };
