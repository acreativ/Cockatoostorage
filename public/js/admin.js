// Signature pad
document.querySelectorAll('canvas.sig').forEach((cv) => {
  const ctx = cv.getContext('2d'); const out = document.getElementById(cv.dataset.target);
  const fit = () => { const r = cv.getBoundingClientRect(); cv.width = r.width * 2; cv.height = r.height * 2; ctx.scale(2, 2); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#17414E'; };
  fit(); let drawing = false, dirty = false;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener('pointerdown', (e) => { drawing = true; cv.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); });
  cv.addEventListener('pointermove', (e) => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); dirty = true; });
  const end = () => { drawing = false; if (dirty) out.value = cv.toDataURL('image/png'); };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointerleave', end);
  document.querySelectorAll(`[data-clear="${cv.id}"]`).forEach((b) => b.addEventListener('click', () => { ctx.clearRect(0, 0, cv.width, cv.height); out.value = ''; dirty = false; }));
});
document.querySelectorAll('[data-confirm]').forEach((el) => el.addEventListener('click', (e) => { if (!confirm(el.dataset.confirm)) e.preventDefault(); }));
