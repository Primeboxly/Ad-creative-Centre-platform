// Sign-in page: plays "how an ad is made" in 5 steps, then the finished ad in a phone with karaoke captions.
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visible = () => !document.getElementById('auth').classList.contains('hidden');

  // ---- The 5 steps ----
  const TIMES = [2600, 2600, 3400, 2600, 6500]; // how long each step stays (ms); the ad plays longest
  let step = 0, stepTimer = null;

  function typeLines() {
    document.querySelectorAll('.act[data-a="2"] .typed').forEach((p, k) => {
      const text = p.dataset.t;
      p.textContent = '';
      let n = 0;
      setTimeout(function tick() {
        p.textContent = text.slice(0, ++n);
        if (n < text.length) setTimeout(tick, 22);
      }, 250 + k * 850);
    });
  }

  function showStep(s) {
    step = s;
    document.querySelectorAll('#scSteps li').forEach(li => {
      const k = Number(li.dataset.s);
      li.classList.toggle('on', k === s);
      li.classList.toggle('done', k < s);
    });
    const line = $('scLine');
    if (line) line.style.width = `${(s / 4) * 100}%`;
    document.querySelectorAll('.theater .act').forEach(a => a.classList.toggle('on', Number(a.dataset.a) === s));
    if (s === 2) typeLines();
    if (s === 4) { ad = 0; playAd(); }
  }

  function nextStep() {
    if (visible()) showStep((step + 1) % 5);
    stepTimer = setTimeout(nextStep, TIMES[step]);
  }

  // ---- The finished ad (step 5): karaoke captions over hook → body → CTA ----
  const SCRIPT = [
    { part: 'hook', words: ['Struggling', 'to', 'find'], key: 0 },
    { part: 'hook', words: ['the', 'perfect', 'gift?'], key: 1 },
    { part: 'body', words: ['a', 'crystal', 'bracelet'], key: 1 },
    { part: 'body', words: ['luxurious', 'gold', 'finish'], key: 0 },
    { part: 'cta', words: ['Order', 'now'], key: 0 },
    { part: 'cta', words: ['pay', 'on', 'delivery'], key: 2 },
  ];
  const PARTS = ['hook', 'body', 'cta'];
  let ad = 0, adTimer = null;

  function playAd() {
    clearTimeout(adTimer);
    const screen = $('scScreen');
    if (!screen) return;
    const g = SCRIPT[ad];
    const inPart = SCRIPT.filter(x => x.part === g.part);
    const pos = inPart.indexOf(g) + 1;
    screen.querySelectorAll('.bars i').forEach(bar => {
      const b = bar.querySelector('b'), idx = PARTS.indexOf(bar.dataset.p), cur = PARTS.indexOf(g.part);
      b.style.width = idx < cur ? '100%' : idx > cur ? '0%' : `${(pos / inPart.length) * 100}%`;
    });
    screen.className = `screen scene-${g.part} shot-${ad % 4}`;
    $('scTag').textContent = g.part.toUpperCase();
    $('scCod').classList.toggle('hidden', g.part !== 'cta');
    $('scArrows').classList.toggle('hidden', g.part !== 'cta');
    const cap = $('scCap');
    cap.innerHTML = g.words.map((w, k) => (k === g.key ? `<em>${esc(w)}</em>` : esc(w))).join(' ');
    cap.classList.remove('pop'); void cap.offsetWidth; cap.classList.add('pop');
    if (++ad < SCRIPT.length) adTimer = setTimeout(playAd, 1000);
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (reduced) { showStep(4); return; }
    showStep(0);
    stepTimer = setTimeout(nextStep, TIMES[0]);
    // Clicking a step jumps to it.
    document.querySelectorAll('#scSteps li').forEach(li => li.addEventListener('click', () => {
      clearTimeout(stepTimer);
      showStep(Number(li.dataset.s));
      stepTimer = setTimeout(nextStep, TIMES[step]);
    }));
  });
})();
