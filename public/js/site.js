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
      const qs = new URLSearchParams({ length: fd.get('length'), unit: fd.get('unit') || 'm', pkg: fd.get('pref') || fd.get('pkg') || 'standard', term: fd.get('term') || 'annual', start: fd.get('start') || '' });
      try {
        const r = await fetch('/api/quote?' + qs); const j = await r.json();
        if (j.error) { out.innerHTML = '<span class="small">' + j.error + '</span>'; return; }
        out.innerHTML = '<span><span class="small muted">' + (j.available ? j.available + ' bays free' : 'Waitlist only') + ' · ' + j.band + '</span></span><span><strong>$' + j.monthly.toLocaleString('en-AU') + '</strong><span class="small muted">/month</span></span>';
      } catch { out.textContent = ''; }
    };
    let t; form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(upd, 200); });
    upd();
  });
})();
