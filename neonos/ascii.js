'use strict';
/* =====================================================================
   NeonOS — motor de animações ASCII
   AsciiScreen: grade de caracteres desenhada em <canvas>.
   Ascii.FX: efeitos (chuva, donut, fogo, plasma, túnel, estrelas, cidade, radar).
   Ascii.*: texto que "decodifica", spinners, barras, fonte grande, artes.
   ===================================================================== */

class AsciiScreen {
  constructor(cv, { size = 14, managed = false, bg = '#05060a' } = {}) {
    this.cv = cv; this.g = cv.getContext('2d'); this.size = size; this.managed = managed; this.bg = bg; this.state = {};
    this.resize();
  }
  resize() {
    if (!this.managed) {
      this.d = Math.min(devicePixelRatio || 1, 2);
      this.cv.width = Math.max(1, this.cv.clientWidth * this.d | 0);
      this.cv.height = Math.max(1, this.cv.clientHeight * this.d | 0);
    }
    const px = this.size * (this.managed ? 1 : this.d);
    this.px = px; this.cw = px * .6; this.ch = px * 1.18;
    this.cols = Math.max(1, Math.floor(this.cv.width / this.cw));
    this.rows = Math.max(1, Math.floor(this.cv.height / this.ch));
    this.chars = new Array(this.cols * this.rows).fill(' ');
    this.colors = new Array(this.cols * this.rows).fill(null);
    this.font = `${px}px "JetBrains Mono","SF Mono",Menlo,Consolas,monospace`;
    this.state = {};
    this.w0 = this.cv.clientWidth; this.h0 = this.cv.clientHeight;
  }
  changed() { return !this.managed && (this.cv.clientWidth !== this.w0 || this.cv.clientHeight !== this.h0); }
  clear() { this.chars.fill(' '); this.colors.fill(null); }
  put(x, y, c, col) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return; const i = y * this.cols + x; this.chars[i] = c; this.colors[i] = col; }
  text(x, y, s, col) { for (let i = 0; i < s.length; i++) this.put(x + i, y, s[i], col); }
  render(bg = this.bg) {
    const { g, cols, rows, cw, ch, chars, colors } = this;
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, this.cv.width, this.cv.height); } else g.clearRect(0, 0, this.cv.width, this.cv.height);
    g.font = this.font; g.textBaseline = 'top';
    let last = null;
    for (let y = 0, i = 0; y < rows; y++) for (let x = 0; x < cols; x++, i++) {
      const c = chars[i], col = colors[i];
      if (c === ' ' || !col) continue;
      if (col !== last) g.fillStyle = last = col;
      g.fillText(c, x * cw, y * ch);
    }
  }
}

/* roda um efeito num canvas até o elemento sair da página */
function asciiLoop(cv, fxName, { size = 14, bg, fps } = {}) {
  let scr = null, raf = 0, last = 0, stopped = false;
  const t0 = performance.now();
  const loop = ts => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    if (!cv.isConnected) return stop();
    const want = fps || (Ascii.full() ? 30 : 15);
    if (document.hidden || ts - last < 1000 / want || !cv.clientWidth) return;
    last = ts;
    const fx = Ascii.FX[loop.fx] || Ascii.FX.rain;
    if (!scr || scr.changed() || scr.fx !== loop.fx) { scr = new AsciiScreen(cv, { size, bg }); scr.fx = loop.fx; fx.init && fx.init(scr); }
    fx.frame(scr, (ts - t0) / 1000);
    scr.render(bg === undefined ? scr.bg : bg);
  };
  const stop = () => { stopped = true; cancelAnimationFrame(raf); };
  loop.fx = fxName;
  raf = requestAnimationFrame(loop);
  return { stop, set: n => { loop.fx = n; } };
}

const Ascii = {
  acc: '#00f0ff', hot: '#ff2a6d', warn: '#f5e663',
  GLYPHS: '!<>-_/[]{}=+*^?#%&$01░▒▓',
  RAIN: 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎ0123456789:.=*+<>|',
  SPIN: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏',
  WAVE: '▁▂▃▄▅▆▇█▇▆▅▄▃▂',
  on() { return SETTINGS.fx !== 'off'; },
  full() { return SETTINGS.fx === 'full'; },
  rnd(s) { return s[Math.random() * s.length | 0]; },

  /* ---- cores ---- */
  _tc: new Map(),
  rgb(hex) { const n = parseInt(hex.slice(1), 16); return [n >> 16, n >> 8 & 255, n & 255]; },
  tint(hex, a) {
    a = Math.round(Math.max(0, Math.min(1, a)) * 20) / 20;
    const k = hex + a; let v = this._tc.get(k);
    if (!v) { const [r, g, b] = this.rgb(hex); v = `rgba(${r},${g},${b},${a})`; this._tc.set(k, v); }
    return v;
  },
  grad(n, ...stops) {
    const k = n + stops.join(); let v = this._tc.get(k);
    if (!v) {
      const cs = stops.map(h => this.rgb(h));
      v = Array.from({ length: n }, (_, i) => {
        const p = i / Math.max(1, n - 1) * (cs.length - 1), j = Math.min(cs.length - 2, p | 0), f = p - j;
        const c = cs[j].map((x, q) => Math.round(x + (cs[j + 1][q] - x) * f));
        return `rgb(${c[0]},${c[1]},${c[2]})`;
      });
      this._tc.set(k, v);
    }
    return v;
  },

  /* ---- texto que decodifica ---- */
  scramble(el, text, dur = 420) {
    if (!el) return;
    text = String(text);
    if (!this.full() || text.length > 160) { el.textContent = text; return; }
    const t0 = performance.now(), n = text.length, id = (el._scr = (el._scr || 0) + 1);
    const step = now => {
      if (el._scr !== id) return;
      const p = Math.min(1, (now - t0) / dur), k = p * n | 0;
      let s = text.slice(0, k);
      for (let i = k; i < n; i++) s += text[i] === ' ' ? ' ' : this.rnd(this.GLYPHS);
      el.textContent = p < 1 ? s : text;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },
  /* revela um bloco de várias linhas em ordem aleatória (logo, artes) */
  decode(el, text, dur = 900) {
    if (!el) return Promise.resolve();
    if (!this.on()) { el.textContent = text; return Promise.resolve(); }
    const chars = [...text], idx = chars.map((c, i) => i).filter(i => !/\s/.test(chars[i]));
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const shown = new Uint8Array(chars.length), t0 = performance.now();
    return new Promise(res => {
      const step = now => {
        const p = Math.min(1, (now - t0) / dur), upto = p * idx.length | 0;
        for (let k = 0; k < upto; k++) shown[idx[k]] = 1;
        el.textContent = chars.map((c, i) => /\s/.test(c) || shown[i] ? c : this.rnd('░▒▓')).join('');
        if (p < 1) requestAnimationFrame(step); else { el.textContent = text; res(); }
      };
      requestAnimationFrame(step);
    });
  },

  /* ---- spinners e barras (um único relógio para todos) ---- */
  loading(text = 'carregando') { return `<span class="aload"><span class="aspin">⠋</span> ${esc(text)}<span class="adots"></span></span>`; },
  bar(w = 12) { return `<span class="abar" data-w="${w}">[${' '.repeat(w)}]</span>`; },
  meter(p, w = 10) { const n = Math.round(Math.max(0, Math.min(1, p)) * w); return '▕' + '█'.repeat(n) + '░'.repeat(w - n) + '▏'; },
  spark(arr, w = 10) { return arr.slice(-w).map(v => '▁▂▃▄▅▆▇█'[Math.max(0, Math.min(7, v / 100 * 8 | 0))]).join('').padStart(w, '▁'); },
  hexLine() {
    const h = () => (Math.random() * 256 | 0).toString(16).padStart(2, '0');
    const bytes = Array.from({ length: 8 }, h);
    return `0x${(Math.random() * 65535 | 0).toString(16).padStart(4, '0')}  ${bytes.join(' ')}  ${bytes.map(b => { const c = parseInt(b, 16); return c > 32 && c < 127 ? String.fromCharCode(c) : '.'; }).join('')}`;
  },
  _i: 0,
  tick() {
    const i = ++this._i;
    $$('.aspin').forEach(e => e.textContent = this.SPIN[i % this.SPIN.length]);
    if (i % 4 === 0) $$('.adots').forEach(e => e.textContent = '.'.repeat((i / 4) % 4));
    $$('.abar').forEach(e => {
      const w = +e.dataset.w || 12, n = 3, span = w - n, p = i % (span * 2), pos = p < span ? p : span * 2 - p;
      e.textContent = '[' + ' '.repeat(pos) + '▓▒░'.slice(0, n) + ' '.repeat(span - pos) + ']';
    });
    $$('.awave').forEach(e => { const w = +e.dataset.w || 24; let s = ''; for (let k = 0; k < w; k++) s += this.WAVE[(k + i) % this.WAVE.length]; e.textContent = s; });
  },
  init() { setInterval(() => this.tick(), 90); },

  /* ---- fonte grande (relógio) ---- */
  FONT: {
    '0': ['████', '█  █', '█  █', '█  █', '████'], '1': [' ██ ', '███ ', ' ██ ', ' ██ ', '████'],
    '2': ['████', '   █', '████', '█   ', '████'], '3': ['████', '   █', ' ███', '   █', '████'],
    '4': ['█  █', '█  █', '████', '   █', '   █'], '5': ['████', '█   ', '████', '   █', '████'],
    '6': ['████', '█   ', '████', '█  █', '████'], '7': ['████', '   █', '  █ ', ' █  ', ' █  '],
    '8': ['████', '█  █', '████', '█  █', '████'], '9': ['████', '█  █', '████', '   █', '████'],
    ':': [' ', '▪', ' ', '▪', ' '], ' ': [' ', ' ', ' ', ' ', ' '],
  },
  big(str) {
    const rows = ['', '', '', '', ''];
    for (const ch of str) { const g = this.FONT[ch] || this.FONT[' ']; for (let r = 0; r < 5; r++) rows[r] += g[r] + ' '; }
    return rows.join('\n');
  },

  /* ---- artes ---- */
  LOGO:
`███╗   ██╗███████╗ ██████╗ ███╗   ██╗ ██████╗ ███████╗
████╗  ██║██╔════╝██╔═══██╗████╗  ██║██╔═══██╗██╔════╝
██╔██╗ ██║█████╗  ██║   ██║██╔██╗ ██║██║   ██║███████╗
██║╚██╗██║██╔══╝  ██║   ██║██║╚██╗██║██║   ██║╚════██║
██║ ╚████║███████╗╚██████╔╝██║ ╚████║╚██████╔╝███████║
╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝`,
  GHOST:
`   ▄▄██████▄▄
  ██▀▀▀██▀▀▀██
  ██  ◉ ██ ◉ ██
  ██▄▄▄▄▄▄▄▄██
  ██ ▀▄▀▄▀▄ ██
  █▀▄█▀  ▀█▄▀█`,
  PHRASES: ['a rede está viva', 'ICE ativo · nenhum intruso detectado', 'sincronizando implantes neurais', 'chuva ácida prevista para as 23h',
    'conexão criptografada ponta a ponta', 'a megacorp está observando', 'firmware do braço cibernético atualizado', 'sinal fraco no setor 7',
    'drones de entrega em rota', 'mercado negro de dados: alta de 3%', 'ghost conectado ao kernel', 'temperatura da cidade: 31°C · neon 100%'],

  /* ---- palavra-marca da área de trabalho: logo com glitch + letreiro ---- */
  wordmark() {
    const logo = $('.wm-logo'), tick = $('.wm-tick'); if (!logo) return;
    const rows = this.LOGO.split('\n');
    this.decode(logo, this.LOGO, 1400);
    const glitch = () => {
      setTimeout(glitch, 2200 + Math.random() * 4000);
      if (!this.full() || document.hidden) return;
      const kind = Math.random();
      if (kind < .55) {
        const r = Math.random() * rows.length | 0, off = 1 + Math.random() * 4 | 0;
        logo.innerHTML = rows.map((l, i) => i === r ? `<span class="wm-g">${esc(' '.repeat(off) + l.slice(0, l.length - off))}</span>` : esc(l)).join('\n');
      } else if (kind < .85) logo.classList.add('chroma');
      else logo.innerHTML = rows.map(l => [...l].map(c => c !== ' ' && Math.random() < .08 ? `<span class="wm-g">${this.rnd('░▒▓')}</span>` : esc(c)).join('')).join('\n');
      setTimeout(() => { logo.textContent = this.LOGO; logo.classList.remove('chroma'); }, 90 + Math.random() * 120);
    };
    setTimeout(glitch, 2500);
    let msg = '', pos = 0;
    const W = 54;
    const build = () => {
      const s = STATS, parts = [`${SYS.user}@${SYS.host}`, ...this.PHRASES.sort(() => Math.random() - .5).slice(0, 4)];
      if (s) parts.splice(1, 0, `CPU ${Math.round(s.cpu)}%`, s.mem_total ? `MEM ${(s.mem_used / 1024).toFixed(1)}/${(s.mem_total / 1024).toFixed(1)} GB` : '', `UPTIME ${fmtUp(s.uptime)}`);
      msg = ' '.repeat(W) + parts.filter(Boolean).join('  ◆  ') + '  ◆  ';
      pos = 0;
    };
    build();
    setInterval(() => {
      if (document.hidden) return;
      if (!this.on()) { tick.textContent = ''; return; }
      if (pos > msg.length - W) build();
      tick.textContent = msg.slice(pos, pos + W).padEnd(W); pos++;
    }, 120);
  },

  /* ---- janela se desfazendo em blocos ---- */
  dissolve(win) {
    return new Promise(res => {
      const cols = Math.ceil(win.clientWidth / 7.2), rows = Math.ceil(win.clientHeight / 13);
      const o = el('pre', 'dissolve'); win.appendChild(o); win.style.pointerEvents = 'none';
      const cells = new Array(cols * rows).fill('▓');
      const steps = ['▓', '▒', '░', ' '];
      let f = 0;
      const draw = () => {
        for (let i = 0; i < cells.length; i++) { const s = steps.indexOf(cells[i]); if (s < 3 && Math.random() < .45) cells[i] = steps[s + 1]; }
        let out = ''; for (let y = 0; y < rows; y++) out += cells.slice(y * cols, (y + 1) * cols).join('') + '\n';
        o.textContent = out; win.style.opacity = 1 - f / 7;
        if (++f < 7) setTimeout(draw, 38); else res();
      };
      draw();
    });
  },
};

/* =====================================================================
   EFEITOS — cada um tem init(scr) opcional e frame(scr, t)
   ===================================================================== */
Ascii.FX = {
  rain: {
    name: 'Chuva digital',
    init(s) {
      s.state.d = Array.from({ length: s.cols }, () => Ascii._drop(s.rows, true));
      s.state.g = Array.from({ length: s.cols * s.rows }, () => Ascii.rnd(Ascii.RAIN));
    },
    frame(s) {
      s.clear();
      const st = s.state, A = Ascii.acc;
      for (let x = 0; x < s.cols; x++) {
        const d = st.d[x]; d.y += d.v;
        if (d.y - d.l > s.rows) st.d[x] = Ascii._drop(s.rows);
        const hy = d.y | 0;
        for (let k = 0; k < d.l; k++) {
          const y = hy - k; if (y < 0 || y >= s.rows) continue;
          const i = y * s.cols + x;
          if (Math.random() < .025) st.g[i] = Ascii.rnd(Ascii.RAIN);
          s.chars[i] = st.g[i]; s.colors[i] = k === 0 ? '#eafcff' : Ascii.tint(A, 1 - k / d.l);
        }
      }
    }
  },
  donut: {
    name: 'Donut 3D',
    init(s) { s.state.z = new Float32Array(s.cols * s.rows); },
    frame(s, t) {
      s.clear();
      const W = s.cols, H = s.rows, z = s.state.z; z.fill(0);
      const A = t * .9, B = t * .45, cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B);
      const asp = s.ch / s.cw, K2 = 5, K1 = Math.min(W * .32, H * asp * .32) * K2 / 3;
      const L = '.,-~:;=!*#$@', pal = Ascii.grad(12, '#7a1fa2', Ascii.hot, Ascii.acc);
      for (let th = 0; th < 6.283; th += .07) {
        const ct = Math.cos(th), st = Math.sin(th);
        for (let ph = 0; ph < 6.283; ph += .02) {
          const cp = Math.cos(ph), sp = Math.sin(ph), cx = 2 + ct, cy = st;
          const x = cx * (cB * cp + sA * sB * sp) - cy * cA * sB;
          const y = cx * (sB * cp - sA * cB * sp) + cy * cA * cB;
          const ooz = 1 / (K2 + cA * cx * sp + cy * sA);
          const xp = (W / 2 + K1 * ooz * x) | 0, yp = (H / 2 - K1 * ooz * y / asp) | 0;
          if (xp < 0 || yp < 0 || xp >= W || yp >= H) continue;
          const lum = cp * ct * sB - cA * ct * sp - sA * st + cB * (cA * st - ct * sA * sp);
          const i = yp * W + xp;
          if (lum > 0 && ooz > z[i]) { z[i] = ooz; const li = Math.min(11, lum * 8 | 0); s.chars[i] = L[li]; s.colors[i] = pal[li]; }
        }
      }
    }
  },
  fire: {
    name: 'Fogo neon',
    init(s) { s.state.f = new Uint8Array(s.cols * s.rows); for (let i = 0; i < s.rows; i++) this.step(s); },
    step(s) {
      const W = s.cols, H = s.rows, f = s.state.f, k = Math.min(1, 36 / (H * .6));
      for (let x = 0; x < W; x++) f[(H - 1) * W + x] = Math.random() < .82 ? 36 : 12 + Math.random() * 20 | 0;
      for (let y = 1; y < H; y++) for (let x = 0; x < W; x++) {
        const src = y * W + x, p = f[src];
        if (!p) { f[src - W] = 0; continue; }
        const r = Math.random() * 3 | 0, dst = src - W - r + 1;
        if (dst >= 0 && dst < W * H) f[dst] = Math.max(0, p - (Math.random() < k ? 1 : 0));
      }
    },
    frame(s) {
      const W = s.cols, H = s.rows, f = s.state.f;
      this.step(s);
      s.clear();
      const C = ' .,:;-=+*#%@', pal = Ascii.grad(37, '#05060a', '#2a0638', '#7a1fa2', Ascii.hot, '#ff7a3d', Ascii.warn, '#ffffff');
      for (let i = 0; i < W * H; i++) {
        const v = f[i]; if (v < 3) continue;
        const j = Math.max(0, Math.min(36, v + (Math.random() * 5 | 0) - 2));
        s.chars[i] = C[Math.min(C.length - 1, j * C.length / 37 | 0)]; s.colors[i] = pal[j];
      }
    }
  },
  plasma: {
    name: 'Plasma',
    frame(s, t) {
      const W = s.cols, H = s.rows, C = ' .:-=+*#%@', pal = Ascii.grad(16, '#2a0638', Ascii.hot, Ascii.acc);
      for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
        const v = Math.sin(x * .09 + t) + Math.sin(y * .18 - t * .8) + Math.sin(x * .06 + y * .11 + t * .6)
          + Math.sin(Math.sqrt((x - W / 2) ** 2 * .01 + (y - H / 2) ** 2 * .04) - t * 1.2);
        const n = Math.max(0, Math.min(.999, (v + 4) / 8));
        s.chars[i] = C[n * 10 | 0]; s.colors[i] = pal[n * 16 | 0];
      }
    }
  },
  tunnel: {
    name: 'Túnel',
    frame(s, t) {
      const W = s.cols, H = s.rows, C = ' .,:;+*#@', k = 2 / Math.min(W * s.cw, H * s.ch), A = Ascii.acc, Hh = Ascii.hot;
      for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
        const X = (x - W / 2) * s.cw * k, Y = (y - H / 2) * s.ch * k, r = Math.hypot(X, Y) + 1e-3;
        const u = .6 / r + t * 1.3, v = Math.atan2(Y, X) / Math.PI * 6 + t * .3, depth = Math.min(1, r * 1.1);
        if (depth < .08) { s.chars[i] = ' '; continue; }
        const on = ((u * 2 | 0) + (v | 0)) & 1;
        s.chars[i] = on ? C[Math.min(8, depth * 9 | 0)] : depth > .45 ? '.' : ' ';
        s.colors[i] = on ? Ascii.tint(A, depth) : Ascii.tint(Hh, depth * .7);
      }
    }
  },
  stars: {
    name: 'Hiperespaço',
    init(s) { s.state.p = Array.from({ length: Math.max(120, s.cols * s.rows / 25 | 0) }, () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() })); },
    frame(s) {
      s.clear();
      const W = s.cols, H = s.rows;
      s.state.p.forEach(p => {
        p.z -= .011;
        if (p.z <= .02) { p.x = Math.random() * 2 - 1; p.y = Math.random() * 2 - 1; p.z = 1; }
        const c = p.z < .2 ? '@' : p.z < .4 ? '*' : p.z < .7 ? '+' : '.';
        s.put(W / 2 + p.x / p.z * W * .5, H / 2 + p.y / p.z * H * .5, c, p.z < .25 ? '#eafcff' : Ascii.tint(Ascii.acc, 1 - p.z));
      });
      s.text((W - 9) / 2, H / 2, '·  ◈  ·', Ascii.tint(Ascii.hot, .5));
    }
  },
  city: {
    name: 'Cidade na chuva',
    init(s) {
      const W = s.cols, H = s.rows, b = [], SIGNS = ['BAR', '24H', 'HOTEL', 'RAMEN', 'NEON', 'DATA', 'CYBER', 'NOODLE', 'ARCADE', 'CLINIC'];
      for (let x = 0; x < W;) {
        const w = 5 + Math.random() * 9 | 0, h = (H * .22 + Math.random() * H * .5) | 0;
        b.push({ x, w, h, seed: Math.random() * 1e6 | 0, sign: Math.random() < .3 ? Ascii.rnd(SIGNS) : null, ant: Math.random() < .3 });
        x += w + (Math.random() * 2 | 0);
      }
      s.state.b = b;
      s.state.drops = Array.from({ length: Math.max(30, W * H / 50 | 0) }, () => ({ x: Math.random() * W * 1.2, y: Math.random() * H, v: .5 + Math.random() * .8 }));
      s.state.stars = Array.from({ length: W / 3 | 0 }, () => [Math.random() * W | 0, Math.random() * H * .4 | 0]);
    },
    frame(s, t) {
      s.clear();
      const W = s.cols, H = s.rows, st = s.state, lights = [Ascii.acc, Ascii.hot, Ascii.warn], tick = t * 2 | 0;
      st.stars.forEach(([x, y], i) => { if ((i + tick) % 13) s.put(x, y, '.', 'rgba(207,233,255,.3)'); });
      s.text(W - 12, 2, '▄██▄', 'rgba(245,230,99,.5)'); s.text(W - 12, 3, '▀██▀', 'rgba(245,230,99,.5)');
      st.b.forEach((b, bi) => {
        const top = H - b.h;
        for (let y = top; y < H; y++) for (let x = b.x; x < b.x + b.w && x < W; x++) {
          const edge = x === b.x || x === b.x + b.w - 1;
          if (y === top) { s.put(x, y, '▄', '#1d2240'); continue; }
          if (edge) { s.put(x, y, '│', '#1b2140'); continue; }
          const hsh = ((x * 73856093) ^ (y * 19349663) ^ b.seed) >>> 0;
          const lit = hsh % 10 < 3 && (hsh >>> 8) % 61 !== tick % 61;
          s.put(x, y, lit ? '▪' : '·', lit ? Ascii.tint(lights[(hsh >>> 4) % 3], .45 + (hsh >>> 6) % 4 * .15) : '#131730');
        }
        if (b.ant) { s.put(b.x + (b.w >> 1), top - 1, '╻', '#1d2240'); if (tick % 2) s.put(b.x + (b.w >> 1), top - 2, '•', Ascii.hot); }
        if (b.sign && b.h > 6 && b.sign.length <= b.w) {
          const on = Math.sin(t * 2.6 + bi * 1.7) > -.7 || Math.random() < .2;
          if (on) s.text(b.x + ((b.w - b.sign.length) >> 1), top + 2, b.sign, bi % 2 ? Ascii.hot : Ascii.acc);
        }
      });
      st.drops.forEach(d => { d.y += d.v; d.x -= d.v * .35; if (d.y >= H || d.x < 0) { d.y = -Math.random() * H * .3; d.x = Math.random() * W * 1.2; } s.put(d.x, d.y, '/', 'rgba(158,200,255,.38)'); });
      for (let x = 0; x < W; x++) s.put(x, H - 1, (x + tick) % 9 ? '▀' : '▄', '#0e1126');
    }
  },
  radar: {
    name: 'Radar',
    init(s) { s.state.blips = []; },
    frame(s, t) {
      s.clear();
      const W = s.cols, H = s.rows, cx = W / 2, cy = H / 2, R = Math.min(W * s.cw, H * s.ch) / 2 * .94;
      const a = (t * 1.5) % (Math.PI * 2), st = s.state, A = Ascii.acc;
      if (Math.random() < .04 && st.blips.length < 8) { const r = Math.random() * R * .9, an = Math.random() * 6.283; st.blips.push({ x: cx + Math.cos(an) * r / s.cw, y: cy + Math.sin(an) * r / s.ch, an, life: 1 }); }
      for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
        const dx = (x - cx) * s.cw, dy = (y - cy) * s.ch, d = Math.hypot(dx, dy);
        if (d > R) continue;
        let diff = (a - Math.atan2(dy, dx)) % (Math.PI * 2); if (diff < 0) diff += Math.PI * 2;
        if (diff < .6) { s.chars[i] = diff < .12 ? '▓' : diff < .3 ? '▒' : '░'; s.colors[i] = Ascii.tint(A, .9 - diff); continue; }
        if (Math.abs(d - R) < s.ch * .5 || Math.abs(d - R * .66) < s.ch * .35 || Math.abs(d - R * .33) < s.ch * .3) { s.chars[i] = '·'; s.colors[i] = Ascii.tint(A, .35); }
        else if (Math.abs(dx) < s.cw * .5 || Math.abs(dy) < s.ch * .5) { s.chars[i] = '·'; s.colors[i] = Ascii.tint(A, .18); }
      }
      st.blips = st.blips.filter(b => {
        let diff = (a - b.an) % (Math.PI * 2); if (diff < 0) diff += Math.PI * 2;
        if (diff < .15) b.life = 1; else b.life -= .006;
        if (b.life > 0) s.put(b.x, b.y, '◆', Ascii.tint(Ascii.hot, b.life));
        return b.life > -.5;
      });
      s.put(cx, cy, '+', '#eafcff');
    }
  },
};
Ascii._drop = (rows, first) => ({ y: first ? Math.random() * rows : -Math.random() * rows * .6, v: .25 + Math.random() * .6, l: 6 + Math.random() * 22 | 0 });

/* =====================================================================
   PROTETOR DE TELA
   ===================================================================== */
const Saver = {
  on: false,
  show(fx) {
    if (this.on) return;
    this.on = true;
    const o = el('div', 'saver');
    o.innerHTML = '<canvas></canvas><pre class="saver-clock"></pre><div class="saver-hint">mexa o mouse ou tecle para voltar</div>';
    document.body.appendChild(o); this.el = o;
    const keys = Object.keys(Ascii.FX).filter(k => k !== 'radar');
    const name = Ascii.FX[fx] ? fx : Ascii.FX[SETTINGS.saverFx] ? SETTINGS.saverFx : Ascii.rnd(keys);
    this.loop = asciiLoop($('canvas', o), name, { size: 15 });
    const clk = () => $('.saver-clock', o).textContent = Ascii.big(new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
    clk(); this.ci = setInterval(clk, 5000);
    const t0 = Date.now();
    this.off = e => { if (Date.now() - t0 < 700) return; if (e.type === 'keydown') { e.preventDefault(); e.stopPropagation(); } this.hide(); };
    ['pointermove', 'pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, this.off, true));
  },
  hide() {
    if (!this.on) return;
    this.on = false; this.loop.stop(); clearInterval(this.ci);
    ['pointermove', 'pointerdown', 'keydown'].forEach(ev => document.removeEventListener(ev, this.off, true));
    this.el.classList.add('out'); setTimeout(() => this.el.remove(), 300);
    if (typeof Lock !== 'undefined') Lock.last = Date.now();
  }
};

/* =====================================================================
   DESLIGAR / REINICIAR: animação de desconexão estilo CRT
   ===================================================================== */
const Bye = {
  async play(label) {
    const o = el('div', 'bye');
    o.innerHTML = `<div class="bye-area"><pre class="bye-art"></pre><div class="bye-t"></div><pre class="bye-bar"></pre><pre class="bye-hex"></pre></div>`;
    document.body.appendChild(o); this.el = o;
    $('.bye-art', o).textContent = Ascii.LOGO;
    Ascii.scramble($('.bye-t', o), `${label.toUpperCase()} · DESCONECTANDO ${SYS.user.toUpperCase()} DA REDE NEON`, 600);
    const hex = $('.bye-hex', o), bar = $('.bye-bar', o), lines = [];
    for (let i = 0; i <= 20; i++) {
      lines.push(Ascii.hexLine()); if (lines.length > 6) lines.shift();
      hex.textContent = lines.join('\n');
      bar.textContent = `[${'█'.repeat(i)}${'░'.repeat(20 - i)}] ${i * 5}%`;
      await sleep(55);
    }
    o.classList.add('crt');
    await sleep(520);
  },
  cancel() { if (this.el) { this.el.remove(); this.el = null; } }
};
