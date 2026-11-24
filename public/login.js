// Sign-in page: a small ad that "plays" in the phone (hook → body → CTA), with karaoke captions like the real ads.
(() => {
  const SCRIPT = [
    { part: 'hook', words: ['Struggling', 'to', 'find'], key: 0 },
    { part: 'hook', words: ['the', 'perfect', 'gift?'], key: 1 },
    { part: 'body', words: ['Skip', 'the', 'generic'], key: 2 },
    { part: 'body', words: ['a', 'crystal', 'bracelet'], key: 1 },
    { part: 'body', words: ['luxurious', 'gold', 'finish'], key: 0 },
    { part: 'body', words: ["she'll", 'love', 'it'], key: 1 },
    { part: 'cta', words: ['Order', 'now'], key: 0 },
    { part: 'cta', words: ['pay', 'on', 'delivery'], key: 2 },
  ];
  const PARTS = ['hook', 'body', 'cta'];
  const STEP = 1300; // ms per caption group
  let i = 0, timer = null;

  const $ = id => document.getElementById(id);
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function show() {
    const screen = $('scScreen');
    if (!screen || document.getElementById('auth').classList.contains('hidden')) return;
    const g = SCRIPT[i];
    // Progress bars: parts before are full, the current one fills with its groups.
    const inPart = SCRIPT.filter(x => x.part === g.part);
    const pos = inPart.indexOf(g) + 1;
    screen.querySelectorAll('.bars i').forEach(bar => {
      const p = bar.dataset.p, b = bar.querySelector('b');
      const idx = PARTS.indexOf(p), cur = PARTS.indexOf(g.part);
      b.style.width = idx < cur ? '100%' : idx > cur ? '0%' : `${(pos / inPart.length) * 100}%`;
    });
    screen.className = `screen scene-${g.part} shot-${i % 4}`;
    $('scTag').textContent = g.part === 'cta' ? 'CTA' : g.part.toUpperCase();
    $('scCod').classList.toggle('hidden', g.part !== 'cta');
    $('scArrows').classList.toggle('hidden', g.part !== 'cta');
    const cap = $('scCap');
    cap.innerHTML = g.words.map((w, k) => (k === g.key ? `<em>${esc(w)}</em>` : esc(w))).join(' ');
    cap.classList.remove('pop');
    void cap.offsetWidth; // restart the pop animation
    cap.classList.add('pop');
    i = (i + 1) % SCRIPT.length;
  }

  function start() {
    if (timer) return;
    show();
    timer = setInterval(show, STEP);
  }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.addEventListener('DOMContentLoaded', () => { i = 1; show(); });
  } else {
    document.addEventListener('DOMContentLoaded', start);
  }
})();
