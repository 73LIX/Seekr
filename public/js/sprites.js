/* Pixel-art toolkit: sprites drawn from text grids, chiptune beeps, confetti, typewriter text. No dependencies.
   window.PX = { sprite, sfx, confetti, typewrite, teamColor } */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';

  // legend: one character = one colour
  const C = {
    D: '#3b2412', W: '#a8672b', L: '#d99a4c', Y: '#ffcc33', y: '#fff1a8', R: '#e8395f', r: '#9c1f3d', P: '#d1117c',
    G: '#3fae49', g: '#25702f', S: '#f3c9a0', K: '#14162e', B: '#6b4423', U: '#4cc9f0', u: '#1d7fa8', N: '#232851',
    E: '#8a90b8', F: '#ffffff', O: '#ff8a3d', V: '#8e5bd6',
  };

  const SPRITES = {
    hero: [
      '..GGGG..',
      '.GGGGgG.',
      '.GggggG.',
      '..SSSS..',
      '..SKSK..',
      '..SSSS..',
      '.PPPPPP.',
      'SPPYYPPS',
      '.PPPPPP.',
      '..BB.BB.',
      '..BB.BB.',
    ],
    chest: [
      '..DDDDDDDD..',
      '.DLLLLLLLLD.',
      'DLLLLLLLLLLD',
      'DDDDDDDDDDDD',
      'DWWWWYYWWWWD',
      'DWWWWYYWWWWD',
      'DWWWWWWWWWWD',
      'DDDDDDDDDDDD',
    ],
    chestOpen: [
      'YY.y..YY..y.',
      '.DDDDDDDDDD.',
      'DLLLLLLLLLLD',
      'DLLWWWWWWLLD',
      '.DDDDDDDDDD.',
      '.YYyYYYYyYY.',
      'DDYYYYYYYYDD',
      'DWWWWYYWWWWD',
      'DWWWWWWWWWWD',
      'DDDDDDDDDDDD',
    ],
    heart: [
      '.RR.RR.',
      'RFRRRRR',
      'RRRRRRR',
      '.RRRRR.',
      '..RRR..',
      '...R...',
    ],
    heartEmpty: [
      '.EE.EE.',
      'E..E..E',
      'E.....E',
      '.E...E.',
      '..E.E..',
      '...E...',
    ],
    coin: [
      '..YYYY..',
      '.YyyYYY.',
      'YyYYYYYY',
      'YyYYWYYY',
      'YYYYWYYY',
      'YYYYYYYY',
      '.YYYYYY.',
      '..YYYY..',
    ],
    x: [
      'PP.....PP',
      'PPP...PPP',
      '.PPP.PPP.',
      '..PPPPP..',
      '...PPP...',
      '..PPPPP..',
      '.PPP.PPP.',
      'PPP...PPP',
      'PP.....PP',
    ],
    flag: [
      'KPPPP...',
      'KPPPPP..',
      'KPPPPPP.',
      'KPPPPP..',
      'KPPPP...',
      'K.......',
      'K.......',
      'K.......',
      'K.......',
      'KKK.....',
    ],
    camera: [
      '..KKKK....',
      'KKKKKKKKKK',
      'KEEEEEEEEK',
      'KEEKKKKEEK',
      'KEKUUUUKEK',
      'KEKUFUUKEK',
      'KEEKKKKEEK',
      'KKKKKKKKKK',
    ],
    qr: [
      'KKK.K.KKK',
      'K.K...K.K',
      'KKK.K.KKK',
      '....K....',
      'K.KK.KK.K',
      '.....K.K.',
      'KKK.KK.KK',
      'K.K..K...',
      'KKK.K.K.K',
    ],
    skull: [
      '.FFFFFF.',
      'FFFFFFFF',
      'FKKFFKKF',
      'FKKFFKKF',
      'FFFKKFFF',
      '.FFFFFF.',
      '.F.FF.F.',
      '..F..F..',
    ],
    trophy: [
      'YYYYYYYYY',
      'YyYYYYYYY',
      'YyYYYYYYY',
      '.YYYYYYY.',
      '..YYYYY..',
      '...YYY...',
      '....Y....',
      '...YYY...',
      '..YYYYY..',
    ],
    scroll: [
      '.FFFFFFFFF.',
      'FYYYYYYYYYF',
      'FYKKKKKKYYF',
      'FYYYYYYYYYF',
      'FYKKKKKYYYF',
      'FYYYYYYYYYF',
      'FYKKKKKKKYF',
      '.FYYYYYYYF.',
    ],
    star: [
      '...Y...',
      '...Y...',
      'YYYYYYY',
      '.YYYYY.',
      '..YYY..',
      '.YY.YY.',
      '.Y...Y.',
    ],
    pawn: [
      '..XX..',
      '.XXXX.',
      '..XX..',
      '.XXXX.',
      'XXXXXX',
      '.XXXX.',
      '.XXXX.',
      'XXXXXX',
    ],
  };

  /** build an <svg> from a named grid. opts: scale (px per pixel), color (replaces X), label */
  function sprite(name, opts = {}) {
    const grid = SPRITES[name];
    const scale = opts.scale || 4;
    const svg = document.createElementNS(NS, 'svg');
    if (!grid) return svg;
    const h = grid.length; const w = grid[0].length;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', String(w * scale)); svg.setAttribute('height', String(h * scale));
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('class', 'sprite sprite-' + name);
    if (opts.label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', opts.label); } else svg.setAttribute('aria-hidden', 'true');
    let out = '';
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        const ch = grid[y][x];
        if (ch === '.') { x++; continue; }
        let x2 = x;
        while (x2 < w && grid[y][x2] === ch) x2++;
        const fill = ch === 'X' ? (opts.color || '#2f9e44') : C[ch] || '#f0f';
        out += `<rect x="${x}" y="${y}" width="${x2 - x}" height="1" fill="${fill}"/>`;
        x = x2;
      }
    }
    svg.innerHTML = out; // constant, generated from the grids above (never from user input)
    return svg;
  }

  /** a stable, bright colour for a team name */
  function teamColor(name) {
    const palette = ['#2f9e44', '#e8395f', '#4cc9f0', '#ffcc33', '#8e5bd6', '#ff8a3d', '#d1117c', '#19b5a5'];
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return palette[h % palette.length];
  }

  // ---------------------------------------------------------------- sound (tiny square-wave beeps)
  const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('th.mute') === '1'; } catch { /* ignore */ }
  const TUNES = {
    click: [[660, 0.04]],
    ok: [[523, 0.08], [784, 0.14]],
    bad: [[196, 0.12], [147, 0.2]],
    hint: [[880, 0.06], [1175, 0.06], [880, 0.06], [1175, 0.1]],
    level: [[523, 0.08], [659, 0.08], [784, 0.08], [1047, 0.2]],
    win: [[523, 0.1], [523, 0.1], [523, 0.1], [698, 0.3], [659, 0.1], [698, 0.1], [784, 0.45], [1047, 0.5]],
    lose: [[392, 0.2], [349, 0.2], [330, 0.2], [262, 0.5]],
  };
  const sfx = {
    muted: () => muted,
    toggle() { muted = !muted; try { localStorage.setItem('th.mute', muted ? '1' : '0'); } catch { /* ignore */ } if (!muted) sfx.play('click'); return muted; },
    play(name) {
      if (muted) return;
      const tune = TUNES[name];
      if (!tune) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = ctx || new AC();
        if (ctx.state === 'suspended') ctx.resume();
        let t = ctx.currentTime + 0.01;
        for (const [freq, dur] of tune) {
          const o = ctx.createOscillator(); const g = ctx.createGain();
          o.type = 'square'; o.frequency.value = freq;
          g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
          o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + dur + 0.02);
          t += dur;
        }
      } catch { /* audio is a nice-to-have */ }
    },
  };

  // ---------------------------------------------------------------- confetti (square pixels falling)
  function confetti(host, n = 60) {
    if (reduced() || !host) return;
    const colors = ['#ffcc33', '#e8395f', '#4cc9f0', '#3fae49', '#d1117c', '#ffffff'];
    const layer = document.createElement('div');
    layer.className = 'confetti';
    layer.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < n; i++) {
      const s = document.createElement('i');
      const size = 6 + Math.floor(Math.random() * 3) * 4;
      s.style.cssText = `left:${Math.random() * 100}%;width:${size}px;height:${size}px;background:${colors[i % colors.length]};animation-duration:${2.4 + Math.random() * 2.4}s;animation-delay:${Math.random() * 1.2}s`;
      layer.append(s);
    }
    host.append(layer);
    setTimeout(() => layer.remove(), 7500);
  }

  // ---------------------------------------------------------------- typewriter: whole text stays in the DOM, letters pop in
  function typewrite(node, text, { speedMs = 18, maxMs = 1800 } = {}) {
    node.textContent = '';
    if (reduced() || text.length > 600) { node.textContent = text; return; }
    const step = Math.min(speedMs, maxMs / Math.max(1, text.length));
    let i = 0;
    for (const ch of text) {
      const s = document.createElement('span');
      s.className = 'tw';
      s.style.animationDelay = `${Math.round(i * step)}ms`;
      s.textContent = ch;
      node.append(s);
      i++;
    }
  }

  window.PX = { sprite, sfx, confetti, typewrite, teamColor, SPRITES };
})();
