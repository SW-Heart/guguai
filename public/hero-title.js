// Homepage headline: 「一句话，」 is typed as a dot-matrix prompt, then 「到成片」 assembles
// from particles that stream out of the caret. The real text takes over when it settles.
// Loaded as a classic script in <head> and started right after the <h1> is parsed, so the
// intro never waits for the page's module graph; the text is hidden only while it plays.
(function (root) {
  const ACCENT = ['#5655da', '#8b6cf0', '#4f8fe8'];
  const TYPE_START = .08;
  const TYPE_STEP = .1;
  const STAGGER = .3;
  const FLY = .7;
  const SETTLE_FADE = .3;

  const lerp = (a, b, k) => a + (b - a) * k;
  const easeOut = x => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  const mix = (from, to, k) => {
    const a = parseInt(from.slice(1), 16), b = parseInt(to.slice(1), 16);
    const channel = shift => Math.round(lerp((a >> shift) & 255, (b >> shift) & 255, k));
    return `rgb(${channel(16)},${channel(8)},${channel(0)})`;
  };
  const accentColor = k => k < .5 ? mix(ACCENT[0], ACCENT[1], k * 2) : mix(ACCENT[1], ACCENT[2], (k - .5) * 2);
  // Deterministic pseudo-random so every visit draws the same choreography.
  const seeded = index => { const x = Math.sin(index * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

  // Timeline for one dot. Lead dots are typed per character; accent dots fly from the caret.
  function dotState(dot, time, caret) {
    if (dot.lead) {
      const k = easeOut((time - (TYPE_START + dot.char * TYPE_STEP + dot.row * .04)) / .14);
      return { x: dot.x, y: dot.y, scale: k, alpha: k };
    }
    const start = TYPE_START + caret.chars * TYPE_STEP + .06 + dot.order * STAGGER;
    const k = easeOut((time - start) / FLY);
    const arc = Math.sin(k * Math.PI) * dot.lift;
    return { x: lerp(caret.x, dot.x, k), y: lerp(caret.y, dot.y, k) - arc, scale: time < start ? 0 : .6 + .4 * k, alpha: time < start ? 0 : Math.min(1, k * 3) };
  }
  const titleDuration = chars => TYPE_START + chars * TYPE_STEP + .06 + STAGGER * 1.12 + FLY;

  function initHeroTitle({ document: doc, window: win }) {
    const title = doc.querySelector('[data-hero-title]');
    const lead = title?.querySelector('[data-title-lead]');
    const accent = title?.querySelector('[data-title-accent]');
    if (!lead || !accent || win.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = doc.createElement('canvas');
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return;
    const reveal = () => title.classList.remove('is-drawing');
    try {
      title.classList.add('is-drawing');
      const box = title.getBoundingClientRect();
      if (!box.width) return reveal();
      const pad = 48;
      const ratio = Math.min(2, win.devicePixelRatio || 1);
      const width = box.width + pad * 2, height = box.height + pad * 2;
      Object.assign(canvas.style, { position: 'absolute', left: `${-pad}px`, top: `${-pad}px`, width: `${width}px`, height: `${height}px`, pointerEvents: 'none' });
      canvas.setAttribute('aria-hidden', 'true');
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);

      // Rasterise both phrases off-screen exactly where the DOM places them, then sample a grid.
      const style = win.getComputedStyle(lead);
      const size = parseFloat(style.fontSize);
      const sample = doc.createElement('canvas');
      sample.width = Math.ceil(width);
      sample.height = Math.ceil(height);
      const sctx = sample.getContext('2d');
      sctx.font = `${style.fontWeight} ${size}px ${style.fontFamily}`;
      sctx.textBaseline = 'middle';
      const place = span => {
        const rect = span.getBoundingClientRect();
        return { x: rect.left - box.left + pad, y: rect.top - box.top + pad + rect.height / 2, w: rect.width, h: rect.height };
      };
      const leadBox = place(lead), accentBox = place(accent);
      const leadChars = [...lead.textContent];
      let cursor = leadBox.x;
      const charEdges = leadChars.map(char => { const left = cursor; cursor += sctx.measureText(char).width; return left; });
      sctx.fillText(lead.textContent, leadBox.x, leadBox.y);
      sctx.fillText(accent.textContent, accentBox.x, accentBox.y);
      const step = Math.max(3, Math.round(size / 24));
      const data = sctx.getImageData(0, 0, sample.width, sample.height).data;
      const dots = [];
      for (let y = 0; y < sample.height; y += step) {
        for (let x = 0; x < sample.width; x += step) {
          if (data[(y * sample.width + x) * 4 + 3] < 140) continue;
          const inLead = y > leadBox.y - leadBox.h / 2 && y < leadBox.y + leadBox.h / 2 && x < leadBox.x + leadBox.w;
          const index = dots.length;
          if (inLead) {
            const char = charEdges.reduce((found, edge, i) => x >= edge ? i : found, 0);
            dots.push({ lead: true, x, y, char, row: (y - (leadBox.y - leadBox.h / 2)) / leadBox.h, color: '#15161e' });
          } else {
            const k = Math.max(0, Math.min(1, (x - accentBox.x) / Math.max(1, accentBox.w)));
            dots.push({ lead: false, x, y, order: k + seeded(index) * .12, lift: 20 + seeded(index + 7) * size * .8, color: accentColor(k) });
          }
        }
      }
      if (!dots.length) return reveal();
      title.append(canvas);
      const caret = { chars: leadChars.length, x: cursor + step * 2, y: leadBox.y, w: Math.max(4, size * .09), h: size * .78 };
      const radius = step * .42;
      const duration = titleDuration(caret.chars);
      let began = 0;

      const draw = now => {
        began ||= now;
        const time = (now - began) / 1000;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const fade = time > duration ? Math.max(0, 1 - (time - duration) / SETTLE_FADE) : 1;
        for (const dot of dots) {
          const state = dotState(dot, time, caret);
          if (state.alpha <= 0) continue;
          ctx.globalAlpha = state.alpha * fade;
          ctx.fillStyle = dot.color;
          ctx.beginPath();
          ctx.arc(state.x, state.y, radius * state.scale, 0, Math.PI * 2);
          ctx.fill();
        }
        // Terminal-style block caret: follows the typing, then hands off to the particles.
        const typed = Math.min(caret.chars, Math.max(0, Math.floor((time - TYPE_START) / TYPE_STEP) + 1));
        const caretX = typed >= caret.chars ? caret.x : (charEdges[typed] ?? caret.x) + step;
        if (time < duration - FLY * .5) {
          ctx.globalAlpha = .85;
          ctx.fillStyle = ACCENT[0];
          ctx.fillRect(caretX, caret.y - caret.h / 2, caret.w, caret.h);
        }
        ctx.globalAlpha = 1;
        if (time > duration) reveal();
        if (time < duration + SETTLE_FADE) win.requestAnimationFrame(draw);
        else canvas.remove();
      };
      win.requestAnimationFrame(draw);
    } catch {
      reveal();
      canvas.remove();
    }
  }

  root.guguHeroTitle = () => initHeroTitle({ document: root.document, window: root });
  root.guguHeroTitleParts = { accentColor, dotState, titleDuration, initHeroTitle };
})(typeof window === 'undefined' ? globalThis : window);
