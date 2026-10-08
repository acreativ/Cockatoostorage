// Consent-gated GA4 + small progressive enhancements.
(function () {
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  function loadGA() {
    if (!window.GA4_ID || window.gtag) return;
    const s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(window.GA4_ID); document.head.appendChild(s);
    window.gtag = function () { dataLayer.push(arguments); };
    gtag('js', new Date()); gtag('config', window.GA4_ID, { anonymize_ip: true });
  }
  const c = get('cm_consent');
  const banner = document.getElementById('consent');
  if (c === 'granted') loadGA();
  else if (!c && banner && window.GA4_ID !== undefined) banner.classList.add('show');
  banner && banner.addEventListener('click', (e) => {
    const v = e.target.getAttribute('data-consent'); if (!v) return;
    set('cm_consent', v); banner.classList.remove('show'); if (v === 'granted') loadGA();
  });
  document.querySelectorAll('[data-track]').forEach((el) => track(el.getAttribute('data-track')));

  // Live quote in the booking box.
  document.querySelectorAll('form[data-live-quote]').forEach((form) => {
    const out = form.querySelector('[data-price]');
    const upd = async () => {
      const fd = new FormData(form);
      if (!fd.get('length')) { out.innerHTML = '<span class="muted small">Enter your boat length to see a price</span>'; return; }
      const qs = new URLSearchParams({ length: fd.get('length'), unit: fd.get('unit') || 'm', start: fd.get('start') || '', end: fd.get('end') || '' });
      const pkg = fd.get('pref') || fd.get('pkg') || 'standard', term = fd.get('term') || 'annual';
      try {
        const r = await fetch('/api/options?' + qs); const d = await r.json();
        const j = (d.options || []).find((o) => o.pkg === pkg && o.term === term);
        if (d.error || !j) { out.innerHTML = '<span class="small">' + (d.error || 'Enter your boat length to see a price') + '</span>'; return; }
        out.innerHTML = '<span><span class="small muted">' + (j.available ? j.available + ' bays free' : 'Waitlist only') + ' · ' + j.months + ' months</span></span><span><strong>$' + j.monthly.toLocaleString('en-AU') + '</strong><span class="small muted">/month</span></span>';
      } catch { out.textContent = ''; }
    };
    const addM = (s, n) => { const [y, m, d] = s.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1 + n, 1)); x.setUTCDate(Math.min(d, new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate())); return x.toISOString().slice(0, 10); };
    const st = form.querySelector('[name=start]'), en = form.querySelector('[name=end]');
    if (st && en) st.addEventListener('change', () => { en.min = addM(st.value, 3); if (en.value < en.min) en.value = addM(st.value, 12); });
    let t; form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(upd, 200); });
    upd();
  });
})();
