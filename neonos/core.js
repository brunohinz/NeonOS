'use strict';
/* =====================================================================
   NeonOS — núcleo: utilidades, backend, sons, notificações, papéis de
   parede animados, gerenciador de janelas, barra de tarefas e bloqueio.
   ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const qs = o => new URLSearchParams(o).toString();
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b/1024).toFixed(1) + ' KB' : b < 1073741824 ? (b/1048576).toFixed(1) + ' MB' : (b/1073741824).toFixed(2) + ' GB';
const fmtUp = s => { s = s|0; const d = s/86400|0, h = (s%86400)/3600|0, m = (s%3600)/60|0; return d ? `${d}d ${h}h` : h ? `${h}h${String(m).padStart(2,'0')}m` : m ? `${m}m${s%60}s` : `${s}s`; };
const fmtTime = s => !isFinite(s) ? '0:00' : `${s/60|0}:${String(s%60|0).padStart(2,'0')}`;
const throttle = (fn, ms) => { let t = 0, tm; return (...a) => { clearTimeout(tm); const now = Date.now(); if (now - t > ms) { t = now; fn(...a); } else tm = setTimeout(() => { t = Date.now(); fn(...a); }, ms); }; };
const bus = { h: {}, on(e, f) { (this.h[e] ||= []).push(f); return () => this.h[e] = this.h[e].filter(x => x !== f); }, emit(e, d) { (this.h[e] || []).forEach(f => f(d)); } };

async function api(path, body) {
  const r = await fetch(path, body !== undefined
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' });
  return r.json();
}

const ICON = {
  wifi: n => `<svg viewBox="0 0 24 24"><path d="M2 9a15 15 0 0 1 20 0" opacity="${n > 2 ? 1 : .3}"/><path d="M5.5 12.5a10 10 0 0 1 13 0" opacity="${n > 1 ? 1 : .3}"/><path d="M9 16a5 5 0 0 1 6 0" opacity="${n > 0 ? 1 : .3}"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/></svg>`,
  eth: `<svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="10"/><path d="M9 14v3h6v-3M12 17v4"/></svg>`,
  off: `<svg viewBox="0 0 24 24"><path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0" opacity=".3"/><path d="M4 4l16 16"/></svg>`,
  vol: m => `<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/>${m ? '<path d="M17 9l5 6M22 9l-5 6"/>' : '<path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a9 9 0 0 1 0 12"/>'}</svg>`,
  bat: (l, ch) => `<svg viewBox="0 0 24 24"><rect x="2" y="7" width="18" height="10"/><path d="M22 10v4"/><rect x="4" y="9" width="${Math.max(1, 14 * l / 100)}" height="6" fill="currentColor" stroke="none"/>${ch ? '<path d="M12 6l-3 6h4l-2 6" stroke="var(--warn)"/>' : ''}</svg>`,
  bt: `<svg viewBox="0 0 24 24"><path d="M7 7l10 10-5 4V3l5 4L7 17"/></svg>`,
  bell: `<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>`,
  moon: `<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>`,
  usb: `<svg viewBox="0 0 24 24"><path d="M12 2v14M8 6l4-4 4 4M7 11v2l5 3 5-3v-3"/><circle cx="12" cy="19" r="2"/><rect x="15" y="8" width="4" height="3"/><circle cx="7" cy="10" r="1.5"/></svg>`,
  sun: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
};

/* ---------------------------------------------------------- configurações */
const THEMES = { cyan: '#00f0ff', magenta: '#ff2a6d', toxic: '#39ff14', amber: '#ffb000', violet: '#b967ff' };
const WALLS = { synthwave: 'Synthwave', rain: 'Cidade na chuva', stars: 'Hiperespaço', grid: 'Grade neon',
  'ascii-city': 'ASCII · Cidade', 'ascii-rain': 'ASCII · Chuva digital', 'ascii-plasma': 'ASCII · Plasma', 'ascii-stars': 'ASCII · Estrelas', none: 'Escuro (leve)' };
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
let SETTINGS = Object.assign({ theme: 'cyan', scan: true, wall: 'synthwave', sound: true, ambient: false, lockIdle: 0, lockOnBoot: false,
  fx: REDUCED ? 'low' : 'full', saver: 5, saverFx: 'random' }, store.get('neonos.settings', {}));
function applySettings() {
  const c = THEMES[SETTINGS.theme] || THEMES.cyan, root = document.documentElement.style;
  Ascii.acc = c;
  document.body.dataset.fx = SETTINGS.fx;
  root.setProperty('--accent', c);
  root.setProperty('--line', c + '59');
  document.body.classList.toggle('noscan', !SETTINGS.scan);
  Wall.setMode(SETTINGS.wall, c);
  Sfx.setAmbient(SETTINGS.ambient);
}
function saveSettings() { store.set('neonos.settings', SETTINGS); applySettings(); bus.emit('settings'); }

/* ---------------------------------------------------------- backend */
let BACKEND = false, SYS = {}, STATS = null;
const RATES = { rx: 0, tx: 0 };
async function connectBackend() {
  for (let i = 0; i < 30; i++) {
    try { const j = await api('/api/ping'); if (j.ok) { BACKEND = true; SYS = j; return true; } } catch {}
    await sleep(400);
  }
  return false;
}
function pollStats() {
  let prev = null;
  const tick = async () => {
    try {
      const s = await api('/api/stats'), now = performance.now();
      if (prev) { const dt = (now - prev.t) / 1000; RATES.rx = Math.max(0, (s.net_rx - prev.rx) / dt); RATES.tx = Math.max(0, (s.net_tx - prev.tx) / dt); }
      prev = { t: now, rx: s.net_rx, tx: s.net_tx };
      STATS = s; bus.emit('stats', s);
    } catch {}
    setTimeout(tick, 1000);
  };
  tick();
}
let WMSEQ = -1;
function pollEvents() {
  let last = null;
  const tick = async () => {
    try {
      const r = await api('/api/events?' + qs({ since: last ?? 0, wm: WMSEQ, wait: last === null ? '' : 1 }));
      if (last !== null && r.last < last) last = r.last;            // o backend reiniciou
      if (last !== null) r.events.forEach(e => e.kind === 'ui' ? uiEvent(e.title, e.data)
        : (SETTINGS.dnd && e.kind !== 'err') ? null
        : toast(e.title, e.body, e.kind, e.data && e.data.open ? () => openPath(e.data.open) : null));
      last = r.last;
      if (r.wm !== WMSEQ) { WMSEQ = r.wm; refreshNative(); }
      setTimeout(tick, 20);
    } catch { setTimeout(tick, 1500); }
  };
  tick();
}

/* ---------------------------------------------------------- janelas dos apps nativos (Steam, LibreOffice, Flatpak...) */
let NATIVE = [], WMOK = false;
async function refreshNative() {
  const r = await api('/api/wm').catch(() => null);
  WMOK = !!(r && r.available); NATIVE = WMOK ? r.windows : [];
  renderNative(); bus.emit('native');
}
function renderNative() {
  const box = $('#ntasks'); if (!box) return;
  const ids = new Set(NATIVE.map(w => String(w.id)));
  $$('.task', box).forEach(b => { if (!ids.has(b.dataset.id)) b.remove(); });
  for (const w of NATIVE) {
    let b = box.querySelector(`[data-id="${w.id}"]`);
    if (!b) {
      b = el('button', 'task native'); b.dataset.id = w.id; box.appendChild(b);
      b.onclick = () => { Sfx.click(); api('/api/wm', { id: w.id, action: 'toggle' }); };
      b.oncontextmenu = e => {
        e.preventDefault(); const c = NATIVE.find(x => x.id === w.id) || w;
        ctxMenu(e.clientX, e.clientY, [
          { label: c.min ? 'Restaurar' : 'Minimizar', fn: () => api('/api/wm', { id: w.id, action: c.min ? 'activate' : 'minimize' }) },
          { label: c.max ? 'Tamanho normal' : 'Maximizar', fn: () => api('/api/wm', { id: w.id, action: c.max ? 'unmaximize' : 'maximize' }) },
          { label: 'Fechar janela', danger: true, fn: () => api('/api/wm', { id: w.id, action: 'close' }) }]);
      };
    }
    const key = [w.title, w.name, w.icon].join('|');
    if (b.dataset.key !== key) {
      b.dataset.key = key; b.title = w.title && w.title !== w.name ? `${w.name} — ${w.title}` : w.name;
      b.innerHTML = `${w.icon ? `<img src="/api/icon?${qs({ wm: w.app_id })}" alt="">` : '<i>◇</i>'}<span>${esc(w.title || w.name)}</span>`;
    }
    b.classList.toggle('on', w.active && !w.min);
    b.classList.toggle('min', w.min);
  }
}
/* A interface é uma janela por baixo dos apps nativos. Quando algo do NeonOS precisa aparecer
   (menu, janela, aviso), ela vem para frente; "temporário" devolve os apps ao fechar. */
const Layer = {
  temp: false, t: null,
  covered() { return WMOK && NATIVE.some(w => !w.min); },
  up(temp = false) {
    clearTimeout(this.t);
    if (!temp) this.temp = false;
    if (!this.covered() || (temp && this.temp)) return;
    if (temp) this.temp = true;
    api('/api/wm/shell', { temp }).catch(() => {});
  },
  down() {
    clearTimeout(this.t);
    this.t = setTimeout(() => { if (this.temp) { this.temp = false; api('/api/wm/restore', {}).catch(() => {}); } }, 90);
  }
};

/* ---------------------------------------------------------- sons (sintetizados, sem arquivos) */
const Sfx = {
  ctx: null, amb: null,
  ac() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; },
  tone(freq, dur = .08, type = 'square', vol = .05, slide = 0, delay = 0) {
    if (!SETTINGS.sound) return;
    try {
      const c = this.ac(), t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + .02);
    } catch {}
  },
  open() { this.tone(660, .06, 'square', .035, 1.5); this.tone(990, .08, 'square', .025, 1, .05); },
  close() { this.tone(520, .09, 'square', .035, .5); },
  click() { this.tone(1500, .02, 'square', .02); },
  notify() { [880, 1320, 1760].forEach((f, i) => this.tone(f, .07, 'triangle', .05, 1, i * .07)); },
  error() { this.tone(160, .2, 'sawtooth', .06, .7); this.tone(120, .25, 'square', .03, .8, .08); },
  boot() { [220, 330, 440, 660, 880].forEach((f, i) => this.tone(f, .35, 'sawtooth', .025, 1.01, i * .09)); this.tone(55, 1.2, 'sine', .08, 1, 0); },
  setAmbient(on) {
    if (on && !this.amb) {
      try {
        const c = this.ac(), out = c.createGain(), f = c.createBiquadFilter();
        out.gain.setValueAtTime(0, c.currentTime); out.gain.linearRampToValueAtTime(.03, c.currentTime + 2);
        f.type = 'lowpass'; f.frequency.value = 380; f.connect(out); out.connect(c.destination);
        const oscs = [55, 55.35, 82.4].map((fr, i) => { const o = c.createOscillator(); o.type = i === 2 ? 'triangle' : 'sawtooth'; o.frequency.value = fr; o.connect(f); o.start(); return o; });
        const lfo = c.createOscillator(), lg = c.createGain(); lfo.frequency.value = .06; lg.gain.value = 160; lfo.connect(lg).connect(f.frequency); lfo.start();
        this.amb = { stop: () => { out.gain.linearRampToValueAtTime(0, c.currentTime + .8); setTimeout(() => { [...oscs, lfo].forEach(o => o.stop()); out.disconnect(); }, 900); } };
      } catch {}
    } else if (!on && this.amb) { this.amb.stop(); this.amb = null; }
  }
};
document.addEventListener('pointerdown', () => { if (Sfx.ctx && Sfx.ctx.state === 'suspended') Sfx.ctx.resume(); });

/* ---------------------------------------------------------- notificações, diálogos, menus */
function toast(title, body = '', kind = 'info', onClick = null) {
  const dur = kind === 'err' ? 8000 : 5500, tag = kind === 'err' ? '×' : kind === 'ok' ? '✓' : '!';
  const t = el('div', 'toast ' + kind, `<b><i>[${tag}]</i> <em></em></b>${body ? `<span>${esc(body)}</span>` : ''}<u class="ttl" style="animation-duration:${dur}ms"></u>`);
  $('#toasts').prepend(t);
  Ascii.scramble($('em', t), title, 380);
  kind === 'err' ? Sfx.error() : Sfx.notify();
  const kill = () => { t.classList.add('out'); setTimeout(() => t.remove(), 400); };
  t.onclick = () => { kill(); if (onClick) onClick(); };
  if (onClick) t.title = 'clique para abrir';
  setTimeout(kill, onClick ? dur * 2 : dur);
  $$('.toast', $('#toasts')).slice(5).forEach(x => x.remove());
}

function ask({ title, text = '', input = null, value = '', ok = 'OK', cancel = 'Cancelar', danger = false }) {
  return new Promise(res => {
    const m = el('div', 'modal');
    m.innerHTML = `<div class="box"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
      ${input ? `<input class="field" type="${input}" value="${esc(value)}" spellcheck="false" autocomplete="off">` : ''}
      <div class="btns">${cancel ? `<button class="btn c">${esc(cancel)}</button>` : ''}<button class="btn o ${danger ? 'hot' : ''}">${esc(ok)}</button></div></div>`;
    document.body.appendChild(m); Layer.up(true);
    Ascii.scramble($('h3', m), `[ ${title} ]`, 320);
    const inp = $('input', m);
    const done = v => { m.remove(); Layer.down(); res(v); };
    $('.o', m).onclick = () => done(input ? inp.value : true);
    if ($('.c', m)) $('.c', m).onclick = () => done(null);
    m.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') $('.o', m).click(); if (e.key === 'Escape') done(null); });
    m.addEventListener('pointerdown', e => { if (e.target === m) done(null); });
    setTimeout(() => { (inp || $('.o', m)).focus(); if (inp) inp.select(); }, 20);
  });
}

/* chama uma rota que pode exigir a senha do usuário (sudo) */
async function rootCall(path, body = {}) {
  let r = await api(path, body);
  if (r.need_password) {
    const pw = await ask({ title: 'Senha de administrador', text: `Esta ação muda uma configuração do sistema. Digite a senha do usuário ${SYS.user}${SYS.live ? ' (no modo live a senha é: live)' : ' (a mesma que você criou no instalador)'}.`, input: 'password', ok: 'Autorizar' });
    if (pw == null) return null;
    r = await api(path, { ...body, password: pw });
    if (r.need_password) { toast('Senha incorreta', '', 'err'); return null; }
  }
  if (r.error) toast('Erro', r.error, 'err');
  return r;
}

function ctxMenu(x, y, items) {
  closeCtx();
  const m = el('div', 'ctx');
  items.forEach(it => { const b = el('button', it.danger ? 'danger' : '', esc(it.label)); b.onclick = () => { closeCtx(); it.fn(); }; m.appendChild(b); });
  document.body.appendChild(m);
  m.style.left = Math.min(x, innerWidth - m.offsetWidth - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - m.offsetHeight - 8) + 'px';
}
function closeCtx() { $$('.ctx').forEach(m => m.remove()); }
document.addEventListener('pointerdown', e => { if (!e.target.closest('.ctx')) closeCtx(); });

/* ---------------------------------------------------------- papéis de parede animados */
const Wall = {
  mode: 'synthwave', acc: '#00f0ff', d: 1, W: 0, H: 0,
  init() {
    this.cv = $('#wall'); this.g = this.cv.getContext('2d');
    addEventListener('resize', () => this.resize()); this.resize();
    let last = 0;
    const loop = ts => { requestAnimationFrame(loop); if (document.hidden || ts - last < 33) return; last = ts; this.draw(ts / 1000); };
    requestAnimationFrame(loop);
  },
  setMode(m, acc) { this.mode = m; this.acc = acc; this.dirty = true; },
  resize() {
    this.d = Math.min(devicePixelRatio || 1, 1.5);
    this.W = this.cv.width = innerWidth * this.d | 0; this.H = this.cv.height = innerHeight * this.d | 0;
    const R = Math.random;
    this.stars = Array.from({ length: 260 }, () => ({ x: R() * 2 - 1, y: R() * 2 - 1, z: R() }));
    this.drops = Array.from({ length: 220 }, () => ({ x: R(), y: R(), l: .02 + R() * .04, s: .6 + R() * .8 }));
    this.mts = Array.from({ length: 26 }, () => R());
    this.city = [0, 1, 2].map(layer => { const out = []; let x = -.02; while (x < 1) { const w = .03 + R() * .06; out.push({ x, w, h: (.14 + R() * .32) * (1 - layer * .25), win: Array.from({ length: 34 }, () => [R(), R(), R() < .35]) }); x += w + R() * .012; } return out; });
    this.dirty = true; this.asc = null;
  },
  draw(t) {
    this.g.globalAlpha = 1;
    const mons = this.monitors && this.monitors.length > 1 && !this.mode.startsWith('ascii-') ? this.monitors : null;
    if (!mons) { this.adv = true; return this.drawOne(t); }
    const { g, d } = this, W0 = this.W, H0 = this.H, dirty = this.dirty;
    if (dirty) { g.fillStyle = '#000'; g.fillRect(0, 0, W0, H0); }
    mons.forEach((m, i) => {
      g.save(); g.translate(m.x * d, m.y * d); g.beginPath(); g.rect(0, 0, m.w * d, m.h * d); g.clip();
      this.W = m.w * d | 0; this.H = m.h * d | 0; this.dirty = dirty; this.adv = i === 0;
      this.drawOne(t); g.restore();
    });
    this.W = W0; this.H = H0; this.dirty = false;
  },
  drawOne(t) {
    const { g, W, H } = this;
    if (this.mode.startsWith('ascii-')) {
      const fx = Ascii.FX[this.mode.slice(6)] || Ascii.FX.city;
      if (!this.asc || this.asc.fx !== fx) { this.asc = new AsciiScreen(this.cv, { size: 15 * this.d, managed: true }); this.asc.fx = fx; fx.init && fx.init(this.asc); }
      if (!Ascii.full() && (this.skip = !this.skip)) return;
      fx.frame(this.asc, t); this.asc.render(); return;
    }
    if (this.mode === 'synthwave') return this.synth(t);
    if (this.mode === 'rain') return this.rain(t);
    if (this.mode === 'stars') return this.warp();
    if (this.mode === 'grid') return this.gridBg(t);
    if (this.dirty) { g.fillStyle = '#05060a'; g.fillRect(0, 0, W, H); const gl = g.createRadialGradient(W / 2, H * .3, 0, W / 2, H * .3, H * .6); gl.addColorStop(0, 'rgba(255,42,109,.12)'); gl.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gl; g.fillRect(0, 0, W, H); this.dirty = false; }
  },
  floor(t, hz, color, alpha) {
    const { g, W, H, d } = this;
    g.save(); g.strokeStyle = color; g.lineWidth = d;
    for (let i = -24; i <= 24; i++) { g.globalAlpha = alpha * .7; g.beginPath(); g.moveTo(W / 2 + i * W * .015, hz); g.lineTo(W / 2 + i * W * .14, H); g.stroke(); }
    const n = 16, f = (t * .45) % 1;
    for (let k = 0; k < n; k++) { const p = (k + f) / n, y = hz + (H - hz) * p * p; g.globalAlpha = alpha * p; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.restore();
  },
  synth(t) {
    const { g, W, H, d } = this, hot = '#ff2a6d', hz = H * .62;
    const sky = g.createLinearGradient(0, 0, 0, hz); sky.addColorStop(0, '#05060a'); sky.addColorStop(1, '#2b0a3d');
    g.fillStyle = sky; g.fillRect(0, 0, W, hz); g.fillStyle = '#07040d'; g.fillRect(0, hz, W, H - hz);
    const r = H * .2, cx = W / 2, cy = hz - r * .55;
    const gl = g.createRadialGradient(cx, cy, r * .8, cx, cy, r * 2); gl.addColorStop(0, 'rgba(255,42,109,.35)'); gl.addColorStop(1, 'rgba(255,42,109,0)');
    g.fillStyle = gl; g.fillRect(0, 0, W, hz);
    const sg = g.createLinearGradient(0, cy - r, 0, cy + r); sg.addColorStop(0, '#f5e663'); sg.addColorStop(.55, hot); sg.addColorStop(1, '#7a1fa2');
    g.save(); g.beginPath(); g.rect(0, 0, W, hz); g.clip(); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip(); g.fillStyle = sg; g.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    g.fillStyle = '#220833'; const step = r * .13, off = (t * 6 * d) % step;
    for (let i = 0; i < 8; i++) { const y = cy + r * .05 + i * step + off; g.fillRect(cx - r, y, 2 * r, (1.5 + i * 1.4) * d); }
    g.restore();
    g.fillStyle = '#0b0614'; g.strokeStyle = hot; g.lineWidth = d; g.beginPath(); g.moveTo(0, hz);
    this.mts.forEach((m, i) => { const x = i / (this.mts.length - 1) * W, dist = Math.abs(x - W / 2) / (W / 2); g.lineTo(x, hz - m * H * .13 * (.25 + dist)); });
    g.lineTo(W, hz); g.closePath(); g.fill(); g.globalAlpha = .55; g.stroke(); g.globalAlpha = 1;
    this.floor(t, hz, hot, .75);
  },
  rain(t) {
    const { g, W, H, d } = this, acc = this.acc;
    const sky = g.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#04050a'); sky.addColorStop(1, '#170b28');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    const shades = ['#0e1020', '#0a0b16', '#05060c'], lights = [acc, '#ff2a6d', '#f5e663'];
    this.city.forEach((layer, li) => layer.forEach(b => {
      const x = b.x * W, w = b.w * W, h = b.h * H, y = H - h;
      g.fillStyle = shades[li]; g.fillRect(x, y, w, h);
      g.globalAlpha = .25 + li * .22;
      b.win.forEach(([wx, wy, on], wi) => { if (!on || (li === 2 && (wi + (t * 1.5 | 0)) % 29 === 0)) return; g.fillStyle = lights[wi % 3]; g.fillRect(x + wx * (w - 6 * d), y + 6 * d + wy * (h - 12 * d), 3 * d, 2 * d); });
      g.globalAlpha = 1;
    }));
    g.strokeStyle = 'rgba(160,200,255,.32)'; g.lineWidth = d; g.beginPath();
    this.drops.forEach(p => { if (this.adv) { p.y += p.s * .014; if (p.y > 1) { p.y = -p.l; p.x = Math.random() * 1.1; } } const x = p.x * W, y = p.y * H; g.moveTo(x, y); g.lineTo(x - p.l * H * .15, y + p.l * H); });
    g.stroke();
  },
  warp() {
    const { g, W, H, d } = this;
    g.fillStyle = this.dirty ? '#05060a' : 'rgba(5,6,10,.35)'; g.fillRect(0, 0, W, H); this.dirty = false;
    const cx = W / 2, cy = H / 2; g.strokeStyle = this.acc; g.lineCap = 'round';
    this.stars.forEach(s => {
      if (this.adv) { s.z -= .006; if (s.z <= .02) { s.x = Math.random() * 2 - 1; s.y = Math.random() * 2 - 1; s.z = 1; return; } }
      const pz = Math.min(1, s.z + .006);
      g.globalAlpha = 1 - s.z; g.lineWidth = (1 - s.z) * 2.2 * d; g.beginPath();
      g.moveTo(cx + s.x / pz * W * .5, cy + s.y / pz * H * .5); g.lineTo(cx + s.x / s.z * W * .5, cy + s.y / s.z * H * .5); g.stroke();
    });
    g.globalAlpha = 1;
  },
  gridBg(t) {
    const { g, W, H } = this;
    g.fillStyle = '#05060a'; g.fillRect(0, 0, W, H);
    const gl = g.createRadialGradient(W / 2, H * .3, 0, W / 2, H * .3, H * .45); gl.addColorStop(0, 'rgba(255,42,109,.3)'); gl.addColorStop(1, 'rgba(255,42,109,0)');
    g.fillStyle = gl; g.fillRect(0, 0, W, H);
    this.floor(t, H * .45, '#ff2a6d', .5);
  }
};

/* ---------------------------------------------------------- gerenciador de janelas */
let zTop = 10, winSeq = 0;
const WINS = new Map();
function openApp(id, arg) {
  const app = APPS[id]; if (!app) return null;
  if (app.launch) { app.launch(arg); return null; }
  if (app.single) {
    const ex = [...WINS.values()].find(r => r.app === id);
    if (ex) { ex.el.classList.remove('min'); focusWin(ex.id); if (arg !== undefined && ex.onArg) ex.onArg(arg); return ex; }
  }
  const wid = ++winSeq, n = WINS.size % 8;
  const w = el('div', 'win' + (app.max ? ' max' : ''));
  const P = PRIMARY || { x: 0, y: 0, w: innerWidth, h: innerHeight };
  const W = Math.min(app.w || 560, P.w - 40), H = Math.min(app.h || 380, P.h - 100);
  w.style.cssText = `left:${P.x + Math.max(10, Math.min(120 + n * 28, P.w - W - 10))}px;top:${P.y + Math.max(10, Math.min(40 + n * 24, P.h - H - 60))}px;width:${W}px;height:${H}px`;
  w.innerHTML = `<div class="bar"><span class="t"></span><button class="m" title="Minimizar">_</button><button class="M" title="Maximizar">□</button><button class="x" title="Fechar">✕</button></div><div class="body"></div>`;
  $('#wins').appendChild(w);
  if (app.max) toggleMax(w, true);
  const task = el('button', 'task');
  $('#wtasks').appendChild(task);
  const rec = { id: wid, app: id, el: w, task, cleanup: [], onArg: null };
  WINS.set(wid, rec);
  const ctx = {
    win: rec, close: () => closeWin(wid), onClose: f => rec.cleanup.push(f),
    setTitle: t => { const s = `${app.icon} ${t}`; if ($('.t', w).textContent !== s) Ascii.scramble($('.t', w), s, 360); task.textContent = s; },
    set onArg(f) { rec.onArg = f; }
  };
  ctx.setTitle(app.name);
  if (Ascii.on()) { w.classList.add('opening'); setTimeout(() => w.classList.remove('opening'), 650); }
  w.addEventListener('pointerdown', () => focusWin(wid));
  $('.x', w).onclick = e => { e.stopPropagation(); closeWin(wid); };
  $('.m', w).onclick = e => { e.stopPropagation(); w.classList.add('min'); w.classList.remove('focus'); refreshTasks(); };
  $('.M', w).onclick = () => toggleMax(w);
  $('.bar', w).ondblclick = e => { if (e.target.tagName !== 'BUTTON') toggleMax(w); };
  task.onclick = () => {
    if (w.classList.contains('min')) { w.classList.remove('min'); focusWin(wid); }
    else if (w.classList.contains('focus')) { w.classList.add('min'); w.classList.remove('focus'); refreshTasks(); }
    else focusWin(wid);
  };
  dragWin(w, $('.bar', w));
  try { app.mount($('.body', w), ctx, arg); } catch (e) { console.error(e); toast('Erro no app ' + app.name, e.message, 'err'); }
  focusWin(wid); Sfx.open(); bus.emit('wins');
  return rec;
}
/* maximizar ocupa só o monitor onde a janela está */
function monitorAt(x, y) { return MONS.find(m => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h) || PRIMARY; }
function toggleMax(w, force) {
  const on = force ?? !w.classList.contains('max');
  if (on) {
    const m = monitorAt(w.offsetLeft + w.offsetWidth / 2, w.offsetTop + 20) || { x: 0, y: 0, w: innerWidth, h: innerHeight, primary: true };
    w.style.setProperty('--mx', m.x + 'px'); w.style.setProperty('--my', m.y + 'px');
    w.style.setProperty('--mw', m.w + 'px'); w.style.setProperty('--mh', (m.h - (m === PRIMARY ? 44 : 0)) + 'px');
  }
  w.classList.toggle('max', on);
}
function focusWin(wid) {
  Layer.up();
  for (const r of WINS.values()) r.el.classList.toggle('focus', r.id === wid);
  const r = WINS.get(wid); if (r) r.el.style.zIndex = ++zTop;
  refreshTasks();
}
function closeWin(wid) {
  const r = WINS.get(wid); if (!r) return;
  r.cleanup.forEach(f => { try { f(); } catch {} });
  r.task.remove(); WINS.delete(wid); Sfx.close(); bus.emit('wins');
  if (Ascii.full() && !r.el.classList.contains('min')) Ascii.dissolve(r.el).then(() => r.el.remove());
  else r.el.remove();
}
function refreshTasks() { for (const r of WINS.values()) r.task.classList.toggle('on', r.el.classList.contains('focus') && !r.el.classList.contains('min')); }
function dragWin(win, handle) {
  handle.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'BUTTON' || win.classList.contains('max')) return;
    const sx = e.clientX - win.offsetLeft, sy = e.clientY - win.offsetTop;
    const move = ev => { win.style.left = Math.max(-win.offsetWidth + 80, Math.min(innerWidth - 80, ev.clientX - sx)) + 'px'; win.style.top = Math.max(0, Math.min(innerHeight - 80, ev.clientY - sy)) + 'px'; };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  });
}

/* ---------------------------------------------------------- área de trabalho e menu */
const MENU = ['terminal', 'files', 'browser', 'steam', 'store', 'programs', 'player', 'tasks', 'hud', 'lab', 'settings', 'installer'];
const SHORTCUTS = [
  ['Wi-Fi e internet', 'rede wifi internet cabo vpn', () => popover($('#tNet'), renderNet)],
  ['Bluetooth', 'fone controle mouse teclado caixa de som', () => openApp('settings', 'bt')],
  ['Impressoras e scanner', 'imprimir impressora escanear', () => openApp('settings', 'print')],
  ['Monitores (Super+P)', 'tela resolucao estender duplicar projetar', () => openApp('settings', 'tela')],
  ['Som', 'volume audio microfone saida', () => openApp('settings', 'sound')],
  ['Energia e bateria', 'suspender desligar tela bateria desempenho', () => openApp('settings', 'power')],
  ['Teclado, data e hora', 'fuso horario relogio layout idioma regiao', () => openApp('settings', 'region')],
  ['Apps padrão e inicialização', 'abrir com padrao iniciar ligar', () => openApp('settings', 'apps')],
  ['Drivers (placa de vídeo)', 'nvidia amd intel driver gpu placa', () => openApp('settings', 'drv')],
  ['Atualizações', 'update atualizar flatpak', () => openApp('settings', 'upd')],
  ['Aparência e papel de parede', 'tema cor wallpaper fundo', () => openApp('settings', 'look')],
  ['Senha, bloqueio e firewall', 'seguranca senha bloqueio firewall', () => openApp('settings', 'sec')],
  ['Gerenciador de tarefas', 'processos travou finalizar ctrl shift esc', () => openApp('tasks')],
  ['Capturar a tela inteira', 'print screenshot captura', () => api('/api/screenshot', {})],
  ['Capturar uma área da tela', 'print recorte captura', () => api('/api/screenshot', { area: true })],
];
let NAPPS = null;
async function loadApps(force) {
  if (!NAPPS || force) NAPPS = (await api('/api/apps').catch(() => ({}))).apps || NAPPS || [];
  return NAPPS;
}
const appIcon = a => a.icon ? `<img src="/api/icon?${qs({ app: a.id })}" alt="">` : '<i>◇</i>';
addEventListener('error', e => { const t = e.target; if (t && t.tagName === 'IMG' && t.src.includes('/api/icon')) t.replaceWith(el('i', '', '◇')); }, true);
async function launchNative(a) {
  const r = await api('/api/apps/launch', { id: a.id }).catch(() => ({ error: 'sem resposta do sistema' }));
  if (r.error) return toast('Não foi possível abrir', r.error, 'err');
  if (r.terminal) openApp('terminal', { cmd: r.terminal }); else toast('Abrindo', a.name);
}
function nativeMenu(a, x, y) {
  const pins = SETTINGS.pins || [];
  ctxMenu(x, y, [
    { label: 'Abrir', fn: () => launchNative(a) },
    pins.includes(a.id)
      ? { label: 'Tirar da área de trabalho', fn: () => { SETTINGS.pins = pins.filter(p => p !== a.id); saveSettings(); buildDesktop(); } }
      : { label: 'Fixar na área de trabalho', fn: () => { SETTINGS.pins = [...pins, a.id]; saveSettings(); buildDesktop(); toast('Fixado na área de trabalho', a.name, 'ok'); } },
    { label: 'Abrir ao ligar o computador', fn: async () => { await api('/api/autostart', { add: a.id }); toast('Vai abrir ao ligar', a.name, 'ok'); } },
  ]);
}
function buildDesktop() {
  const box = $('#icons'); box.innerHTML = '';
  const add = (glyph, name, open, menu) => {
    const ic = el('div', 'icon', `<div class="glyph">${glyph}</div><div class="lbl">${esc(name)}</div>`);
    ic.onmouseenter = () => Ascii.scramble($('.lbl', ic), name, 260);
    ic.onclick = () => { $$('.icon').forEach(x => x.classList.remove('sel')); ic.classList.add('sel'); Sfx.click(); };
    ic.ondblclick = open;
    if (menu) ic.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); menu(e); };
    box.appendChild(ic);
  };
  for (const id of DESK) {
    const a = APPS[id]; if (!a || (a.visible && !a.visible())) continue;
    add(a.svg || a.icon, a.name, () => openApp(id));
  }
  for (const id of SETTINGS.pins || []) {
    const a = (NAPPS || []).find(x => x.id === id); if (!a) continue;
    add(`<span class="nat">${appIcon(a)}</span>`, a.name, () => launchNative(a), e => nativeMenu(a, e.clientX, e.clientY));
  }
}
function buildStart() {
  const sm = $('#startMenu');
  sm.innerHTML = `<div class="sm-banner"><pre class="sm-logo">▲ N E O N // O S</pre><pre class="sm-sub"></pre><pre class="awave" data-w="34"></pre></div>
    <input class="field sm-q" placeholder="buscar apps e configurações…" spellcheck="false" autocomplete="off">
    <div class="sm-main"><div class="sm-home"><h4>// NEONOS</h4><div class="sm-grid"></div>
      <h4>// TODOS OS APPS <small class="c-d sm-n"></small></h4><div class="sm-all"><div class="c-d">${Ascii.loading('indexando')}</div></div></div>
      <div class="sm-res"></div></div>
    <div class="sm-foot"><button data-x="lock" title="Bloquear (Super+L)">⌧ Bloquear</button><button data-x="suspend">◐ Suspender</button>
      <button data-x="reboot" class="danger">⟲ Reiniciar</button><button data-x="poweroff" class="danger">⏻ Desligar</button></div>`;
  const grid = $('.sm-grid', sm);
  for (const id of MENU) {
    const a = APPS[id]; if (!a || (a.visible && !a.visible())) continue;
    const b = el('button', 'sm-app', `<span class="sm-ic">${a.svg || a.icon}</span><span>${esc(a.name)}</span>`);
    b.onclick = () => { closeStart(); openApp(id); };
    grid.appendChild(b);
  }
  $$('.sm-foot button', sm).forEach(b => b.onclick = () => { closeStart(); b.dataset.x === 'lock' ? Lock.show() : powerAction(b.dataset.x); });
  const q = $('.sm-q', sm);
  q.oninput = () => startSearch(q.value);
  q.onkeydown = e => {
    e.stopPropagation();
    const items = $$('.sm-res .hit', sm); let i = items.findIndex(x => x.classList.contains('sel'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!items.length) return;
      items.forEach(x => x.classList.remove('sel'));
      i = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[i].classList.add('sel'); items[i].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { const t = items[i] || items[0]; if (t) t.click(); }
    else if (e.key === 'Escape') { if (q.value) { q.value = ''; startSearch(''); } else closeStart(); }
  };
}
function renderAllApps() {
  const sm = $('#startMenu'), box = $('.sm-all', sm); if (!box) return;
  box.innerHTML = NAPPS && NAPPS.length ? '' : '<div class="c-d">Nenhum app instalado ainda — veja a Loja.</div>';
  (NAPPS || []).forEach(a => {
    const b = el('button', 'sm-row', `<span class="sm-ni">${appIcon(a)}</span><span>${esc(a.name)}</span>`);
    b.title = a.comment || a.name;
    b.onclick = () => { closeStart(); launchNative(a); };
    b.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); nativeMenu(a, e.clientX, e.clientY); };
    box.appendChild(b);
  });
  $('.sm-n', sm).textContent = NAPPS ? `(${NAPPS.length})` : '';
}
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function startSearch(text) {
  const sm = $('#startMenu'), res = $('.sm-res', sm), T = norm(text.trim());
  sm.classList.toggle('searching', !!T);
  res.innerHTML = '';
  if (!T) return;
  const hits = [];
  MENU.forEach(id => {
    const a = APPS[id];
    if (a && (!a.visible || a.visible()) && norm(`${a.name} ${a.kw || ''}`).includes(T))
      hits.push({ ic: a.svg || a.icon, name: a.name, sub: 'NeonOS', go: () => openApp(id) });
  });
  (NAPPS || []).forEach(a => {
    if (norm(`${a.name} ${a.comment} ${a.keywords}`).includes(T))
      hits.push({ ic: appIcon(a), name: a.name, sub: a.comment || 'app', go: () => launchNative(a), menu: e => nativeMenu(a, e.clientX, e.clientY) });
  });
  SHORTCUTS.forEach(([name, kw, fn]) => { if (norm(`${name} ${kw}`).includes(T)) hits.push({ ic: '⚙', name, sub: 'configuração', go: fn }); });
  hits.push({ ic: '⬡', name: `Procurar "${text.trim()}" na Loja`, sub: 'instalar apps novos', go: () => openApp('store', text.trim()) });
  hits.slice(0, 14).forEach((h, i) => {
    const b = el('button', 'sm-row hit' + (i ? '' : ' sel'), `<span class="sm-ni">${h.ic}</span><span>${esc(h.name)}<small>${esc(h.sub)}</small></span>`);
    b.onclick = () => { closeStart(); h.go(); };
    if (h.menu) b.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); h.menu(e); };
    res.appendChild(b);
  });
}
function toggleStart(force) {
  const sm = $('#startMenu'), open = force ?? !sm.classList.contains('open');
  if (!open) return closeStart();
  if (sm.classList.contains('open')) return;
  closePop(); Layer.up(true);
  sm.classList.add('open'); Sfx.click();
  const q = $('.sm-q', sm); q.value = ''; startSearch(''); setTimeout(() => q.focus(), 40);
  Ascii.scramble($('.sm-sub', sm), `sessão de ${SYS.user} · ${SYS.kernel}`, 500);
  loadApps(true).then(renderAllApps);
}
function closeStart() {
  const sm = $('#startMenu');
  if (!sm.classList.contains('open')) return;
  sm.classList.remove('open'); Layer.down();
}
async function powerAction(a) {
  const label = { poweroff: 'Desligar', reboot: 'Reiniciar', suspend: 'Suspender' }[a];
  if (a !== 'suspend' && !await ask({ title: label + '?', text: 'Arquivos não salvos serão perdidos.', ok: label, danger: true })) return;
  if (a === 'suspend') Lock.show();
  else { Sfx.boot(); await Bye.play(label); }
  const r = await rootCall('/api/power', { action: a });
  if (!r || !r.ok) {
    Bye.cancel();
    if (r && !r.error) toast('Não foi possível ' + label.toLowerCase(), r.out || '', 'err');
  }
}

/* ---------------------------------------------------------- bandeja: rede, som, brilho, bateria, relógio */
let POP = null;
function popover(btn, render) {
  if (POP && POP.btn === btn) return closePop();
  closePop(); Sfx.click(); Layer.up(true);
  const p = el('div', 'pop'); document.body.appendChild(p); POP = { el: p, btn }; render(p);
}
function closePop() { if (POP) { POP.el.remove(); POP = null; Layer.down(); } }
document.addEventListener('pointerdown', e => { if (POP && !POP.el.contains(e.target) && !POP.btn.contains(e.target) && !e.target.closest('.modal')) closePop(); });

async function refreshNetIcon() {
  try {
    const n = await api('/api/net?quick=1');
    const b = $('#tNet');
    if (!n.available) { b.innerHTML = ICON.off; b.title = 'Rede: indisponível'; return; }
    if (n.kind === 'ethernet') { b.innerHTML = ICON.eth; b.title = 'Cabo: ' + n.name; }
    else if (n.kind === 'wifi') { b.innerHTML = ICON.wifi(n.signal > 66 ? 3 : n.signal > 33 ? 2 : 1); b.title = `Wi-Fi: ${n.name} (${n.signal}%)`; }
    else { b.innerHTML = ICON.off; b.title = 'Desconectado'; }
  } catch {}
}
async function renderNet(p) {
  p.innerHTML = `<h4>// REDE</h4><div class="c-d">${Ascii.loading('varrendo frequências')}</div>`;
  const n = await api('/api/net');
  if (!n.available) { p.innerHTML = `<h4>// REDE</h4><div class="c-d">NetworkManager indisponível neste sistema.</div>`; return; }
  p.innerHTML = `<h4>// REDE <button class="mini rs" title="Procurar de novo">↻</button></h4>
    <label class="row"><input type="checkbox" class="wr" ${n.wifi_on ? 'checked' : ''}> Wi-Fi ligado</label>
    ${n.ethernet ? `<div class="net on">${ICON.eth}<span>Cabo conectado</span></div>` : ''}<div class="nets"></div>`;
  const box = $('.nets', p);
  if (n.wifi_on && !n.networks.length) box.innerHTML = '<div class="c-d">nenhuma rede encontrada</div>';
  n.networks.forEach(w => {
    const b = el('button', 'net' + (w.active ? ' on' : ''), `${ICON.wifi(w.signal > 66 ? 3 : w.signal > 33 ? 2 : 1)}<span>${esc(w.ssid)}</span><small>${w.secure ? '<span class="c-h">◆</span> ' : ''}${w.signal}%</small>`);
    b.onclick = async () => {
      if (w.active) return;
      let key = '';
      if (w.secure) { key = await ask({ title: w.ssid, text: 'Senha da rede Wi-Fi', input: 'password', ok: 'Conectar' }); if (key == null) return; }
      toast('Conectando…', w.ssid);
      const r = await rootCall('/api/net/connect', { ssid: w.ssid, key });
      if (r && r.ok) toast('Conectado', w.ssid, 'ok'); else if (r && !r.error) toast('Falha ao conectar', r.out || '', 'err');
      refreshNetIcon(); if (POP && POP.el === p) renderNet(p);
    };
    box.appendChild(b);
  });
  $('.rs', p).onclick = async () => { box.innerHTML = `<div class="c-d">${Ascii.loading('varrendo')}</div>`; await api('/api/net/rescan', {}); setTimeout(() => POP && POP.el === p && renderNet(p), 2500); };
  p.insertAdjacentHTML('beforeend', '<button class="btn vpn" style="margin-top:10px;width:100%">Configurações avançadas e VPN…</button>');
  $('.vpn', p).onclick = () => { closePop(); api('/api/tool', { tool: 'network' }).then(r => r.error && toast('Erro', r.error, 'err')); };
  $('.wr', p).onchange = async e => { await rootCall('/api/net/radio', { on: e.target.checked }); setTimeout(() => { refreshNetIcon(); if (POP && POP.el === p) renderNet(p); }, 1500); };
}
async function renderQuick(p) {
  p.innerHTML = `<h4>// CONTROLES</h4><div class="q c-d">${Ascii.loading()}</div>`;
  const [a, b, n, bt, pw] = await Promise.all(['/api/audio', '/api/brightness', '/api/net?quick=1', '/api/bt', '/api/power/settings']
    .map(u => api(u).catch(() => ({}))));
  const q = $('.q', p); if (!q) return; q.className = 'q';
  const prof = pw.profiles, PN = { 'power-saver': 'Economia', balanced: 'Equilibrado', performance: 'Desempenho' };
  q.innerHTML = (a.available ? `<div class="slider-row"><button class="mini mu" title="Mudo">${ICON.vol(a.muted)}</button><input type="range" class="va" min="0" max="100" value="${a.volume}"><span class="vv">${a.volume}%</span></div>` : '<div class="c-d">Áudio do sistema indisponível</div>')
    + (b.available ? `<div class="slider-row"><span class="mini">${ICON.sun}</span><input type="range" class="ba" min="1" max="100" value="${b.percent}"><span class="bv">${b.percent}%</span></div>` : '')
    + `<div class="qt">
        <button class="qt-b ${n.wifi_on ? 'on' : ''}" data-q="wifi" ${n.available ? '' : 'disabled'}>${ICON.wifi(3)}<span>Wi-Fi</span></button>
        <button class="qt-b ${bt.powered ? 'on' : ''}" data-q="bt" ${bt.available ? '' : 'disabled'} title="${bt.available ? '' : esc(bt.reason || '')}">${ICON.bt}<span>Bluetooth</span></button>
        <button class="qt-b ${SETTINGS.dnd ? 'on' : ''}" data-q="dnd">${ICON.bell}<span>Não perturbe</span></button>
        <button class="qt-b ${pw.night_on ? 'on' : ''}" data-q="night" ${pw.night_ok ? '' : 'disabled'}>${ICON.moon}<span>Luz noturna</span></button></div>`
    + (prof && prof.options && prof.options.length ? `<div class="qp"><small class="c-d">ENERGIA</small><div class="fx-pick">${prof.options.map(o => `<button data-p="${esc(o)}" class="${o === prof.current ? 'on' : ''}">${PN[o] || esc(o)}</button>`).join('')}</div></div>` : '')
    + `<div class="qa"><button class="btn" data-q="shot">▣ Capturar tela</button><button class="btn" data-q="set">⚙ Configurações</button></div>
       <hr style="border:0;border-top:1px dashed var(--line);margin:10px 0">
       <label class="row"><input type="checkbox" class="sf" ${SETTINGS.sound ? 'checked' : ''}> Sons da interface</label>
       <label class="row"><input type="checkbox" class="am" ${SETTINGS.ambient ? 'checked' : ''}> Zumbido ambiente</label>`;
  if (a.available) {
    const va = $('.va', q);
    va.oninput = throttle(() => { $('.vv', q).textContent = va.value + '%'; api('/api/audio', { volume: +va.value }).then(setVolIcon); }, 80);
    va.onchange = () => Sfx.click();
    $('.mu', q).onclick = async () => { const r = await api('/api/audio', { mute: !a.muted }); a.muted = r.muted; $('.mu', q).innerHTML = ICON.vol(a.muted); setVolIcon(r); };
  }
  if (b.available) { const ba = $('.ba', q); ba.oninput = throttle(() => { $('.bv', q).textContent = ba.value + '%'; api('/api/brightness', { percent: +ba.value }); }, 80); }
  const flip = btn => btn.classList.toggle('on');
  $$('[data-q]', q).forEach(btn => btn.onclick = async () => {
    const on = btn.classList.contains('on'), k = btn.dataset.q;
    if (k === 'wifi') { flip(btn); await rootCall('/api/net/radio', { on: !on }); setTimeout(refreshNetIcon, 1500); }
    else if (k === 'bt') { flip(btn); const r = await api('/api/bt/power', { on: !on }); if (r.error) { flip(btn); toast('Bluetooth', r.error, 'err'); } }
    else if (k === 'dnd') { flip(btn); SETTINGS.dnd = !on; saveSettings(); api('/api/dnd', { on: !on }); }
    else if (k === 'night') { flip(btn); api('/api/power/settings', { night: !on }); }
    else if (k === 'shot') { closePop(); setTimeout(() => api('/api/screenshot', {}), 250); }
    else if (k === 'set') { closePop(); openApp('settings'); }
  });
  $$('[data-p]', q).forEach(btn => btn.onclick = () => { $$('[data-p]', q).forEach(x => x.classList.toggle('on', x === btn)); api('/api/power/settings', { profile: btn.dataset.p }); });
  $('.sf', q).onchange = e => { SETTINGS.sound = e.target.checked; saveSettings(); };
  $('.am', q).onchange = e => { SETTINGS.ambient = e.target.checked; saveSettings(); };
}
function renderCal(p, off = 0) {
  const now = new Date(), d = new Date(now.getFullYear(), now.getMonth() + off, 1);
  const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  let cells = '<span></span>'.repeat(d.getDay());
  for (let i = 1; i <= days; i++) cells += `<span class="${off === 0 && i === now.getDate() ? 'today' : ''}">${i}</span>`;
  p.innerHTML = `<h4>// ${esc(d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).toUpperCase())} <span><button class="mini pv" title="Mês anterior">‹</button> <button class="mini nx" title="Próximo mês">›</button></span></h4>
    <div class="cal">${['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map(x => `<b>${x}</b>`).join('')}${cells}</div>
    <div class="cal-foot"><span>${esc(now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }))}</span><button class="mini ad">ajustar</button></div>`;
  $('.pv', p).onclick = () => renderCal(p, off - 1);
  $('.nx', p).onclick = () => renderCal(p, off + 1);
  $('.ad', p).onclick = () => { closePop(); openApp('settings', 'region'); };
}
let DRIVES = [];
async function refreshDrives() {
  const d = await api('/api/drives').catch(() => ({}));
  DRIVES = d.drives || [];
  const b = $('#tDrv'), rem = DRIVES.filter(x => x.removable);
  b.style.display = rem.length ? '' : 'none'; b.innerHTML = ICON.usb;
  b.title = rem.length ? `${rem.length} pendrive(s) ou disco(s) externo(s)` : '';
  if (POP && POP.btn === b) renderDrives(POP.el);
}
async function driveOpen(d) {
  let path = d.mount;
  if (!path) { const r = await api('/api/drives/mount', { dev: d.dev }); if (r.error) return toast('Não foi possível abrir', r.error, 'err'); path = r.path; }
  if (path) openApp('files', path);
}
async function driveEject(d) {
  const r = await api('/api/drives/eject', { dev: d.dev });
  if (r.error) toast('Ainda em uso', r.error, 'err'); else toast('Pode remover com segurança', d.label || d.model || d.dev, 'ok');
  refreshDrives();
}
function renderDrives(p) {
  const rem = DRIVES.filter(x => x.removable);
  p.innerHTML = `<h4>// DISPOSITIVOS</h4>${rem.length ? '' : '<div class="c-d">nenhum pendrive conectado</div>'}`;
  rem.forEach(d => {
    const r = el('div', 'drv', `<span>${ICON.usb}</span><div><b>${esc(d.label || d.model || 'Pendrive')}</b><small>${fmtSize(d.size)} · ${esc(d.fstype || '')}${d.mount ? '' : ' · não aberto'}</small></div><button class="mini op">abrir</button><button class="mini ej" title="Remover com segurança">⏏</button>`);
    $('.op', r).onclick = () => { closePop(); driveOpen(d); };
    $('.ej', r).onclick = () => driveEject(d);
    p.appendChild(r);
  });
}
function setVolIcon(a) { if (a && a.available) $('#tQuick').innerHTML = ICON.vol(a.muted || a.volume === 0); }
function trayInit() {
  $('#tNet').onclick = () => popover($('#tNet'), renderNet);
  $('#tQuick').onclick = () => popover($('#tQuick'), renderQuick);
  $('#tQuick').innerHTML = ICON.vol(false);
  $('#clock').onclick = () => popover($('#clock'), p => renderCal(p));
  $('#tDrv').onclick = () => popover($('#tDrv'), renderDrives);
  const cpuHist = [];
  const tick = () => {
    const now = new Date();
    $('#clock').textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', ...(SETTINGS.clockSec ? { second: '2-digit' } : {}) });
    if (STATS) {
      cpuHist.push(STATS.cpu); if (cpuHist.length > 12) cpuHist.shift();
      $('#tCpu').innerHTML = `CPU <span class="spark">${Ascii.on() ? Ascii.spark(cpuHist, 8) : ''}</span> ${Math.round(STATS.cpu)}%`;
      const bat = STATS.battery, tb = $('#tBat');
      tb.style.display = bat ? '' : 'none';
      if (bat) { tb.innerHTML = `${ICON.bat(bat.level, bat.charging)}${bat.level}%`; tb.style.color = bat.level < 15 && !bat.charging ? 'var(--hot)' : ''; }
      if (bat && bat.level <= 10 && !bat.charging && !trayInit.warned) { trayInit.warned = true; toast('Bateria fraca', `${bat.level}% restante — conecte o carregador`, 'err'); }
      if (bat && bat.charging) trayInit.warned = false;
    }
    if (Lock.on) Lock.tick();
  };
  tick(); setInterval(tick, 1000);
  setInterval(refreshNetIcon, 15000);
}

/* ---------------------------------------------------------- tela de bloqueio */
const Lock = {
  on: false, last: Date.now(),
  init() {
    $('#lockPw').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') this.submit(); });
    ['pointermove', 'keydown', 'pointerdown'].forEach(ev => document.addEventListener(ev, () => this.last = Date.now(), { passive: true }));
    setInterval(() => {
      if (SYS.idle) return;                       // o swayidle cuida (vale também para apps nativos)
      const idle = Date.now() - this.last;
      if (!this.on && SETTINGS.lockIdle > 0 && idle > SETTINGS.lockIdle * 60000) this.show();
      if (!Saver.on && BACKEND && SETTINGS.saver > 0 && idle > SETTINGS.saver * 60000) Saver.show();
    }, 5000);
  },
  show() {
    if (this.on || !BACKEND) return;
    this.on = true; closePop(); closeStart();
    api('/api/wm/shell', { temp: true }).then(() => api('/api/wm/guard', { on: true })).catch(() => {});
    $('#lock').classList.add('on'); $('#lockPw').value = ''; $('#lockMsg').textContent = '';
    $('#lock .hint').textContent = SYS.live || SYS.dev ? 'modo live — senha padrão: live' : '';
    if (Ascii.on()) this.fx = asciiLoop($('#lockFx'), 'donut', { size: 11, bg: null });
    Ascii.scramble($('#lock .user'), `${SYS.user}@${SYS.host || 'neon'}`.toUpperCase(), 600);
    this.tick(); setTimeout(() => $('#lockPw').focus(), 60); Sfx.close();
  },
  tick() {
    const n = new Date(), hm = n.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    $('#lockClock').textContent = Ascii.big(n.getSeconds() % 2 ? hm : hm.replace(':', ' '));
    $('#lockDate').textContent = n.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  },
  async submit() {
    const pw = $('#lockPw').value; if (!pw) return;
    $('#lockMsg').innerHTML = Ascii.loading('verificando');
    const r = await api('/api/auth', { password: pw }).catch(() => ({}));
    if (r.ok) {
      $('#lockMsg').textContent = '';
      Ascii.scramble($('#lockDate'), 'ACESSO CONCEDIDO', 300);
      await sleep(Ascii.full() ? 380 : 0);
      this.on = false; this.last = Date.now(); $('#lock').classList.remove('on'); Sfx.open();
      api('/api/wm/guard', { on: false }).then(() => api('/api/wm/restore', {})).catch(() => {});
      if (this.fx) { this.fx.stop(); this.fx = null; }
      return;
    }
    Ascii.scramble($('#lockMsg'), 'ACESSO NEGADO', 300); $('#lockPw').value = ''; Sfx.error();
    const box = $('#lock .box'); box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
  }
};

/* ---------------------------------------------------------- atalhos globais */
document.addEventListener('keydown', e => {
  if (Lock.on) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && e.altKey && k === 'l') { e.preventDefault(); Lock.show(); }
  else if (e.altKey && !e.ctrlKey && k === 't') { e.preventDefault(); openApp('terminal'); }
  else if (e.metaKey && k === 'p') { e.preventDefault(); showDisplayMenu(); }
  else if (e.ctrlKey && e.shiftKey && k === 'escape') { e.preventDefault(); openApp('tasks'); }
  else if ((e.ctrlKey && k === 'escape') || (e.key === 'Meta' && !e.repeat && !WMOK)) toggleStart();
});

/* ---------------------------------------------------------- boot */
function bootScreen() {
  return new Promise(resolve => {
    const b = $('#boot'), log = $('#bootLog'), hex = $('.hex', b), prog = $('.prog', b);
    Ascii.decode($('.logo', b), Ascii.LOGO, 750);
    const lines = ['conectando ao kernel Linux', 'abrindo ponte bash ↔ neon-shell', 'injetando daemon de áudio (pipewire)', 'varrendo interfaces de rede',
      'sincronizando relógio atômico', 'montando /home do usuário', 'carregando ICE de proteção', 'iniciando neon-wm', 'sistema pronto'];
    let i = 0, done = false;
    const hx = [];
    const hexIv = setInterval(() => { hx.push(Ascii.hexLine()); if (hx.length > 48) hx.shift(); hex.textContent = hx.join('\n'); }, 40);
    const finish = () => {
      if (done) return; done = true; clearInterval(iv); clearInterval(hexIv);
      b.classList.add('leave'); setTimeout(() => b.remove(), 650); Sfx.boot(); resolve();
    };
    const iv = setInterval(() => {
      const p = i / lines.length, n = p * 32 | 0;
      prog.textContent = `[${'█'.repeat(n)}${'░'.repeat(32 - n)}] ${String(Math.round(p * 100)).padStart(3)}%`;
      if (i >= lines.length) { clearInterval(iv); setTimeout(finish, 380); return; }
      const ln = el('div', 'ln', `[ <span>OK</span> ] <em></em>`); log.appendChild(ln);
      Ascii.scramble($('em', ln), lines[i++], 180);
    }, 165);
    b.onclick = finish; addEventListener('keydown', finish, { once: true });
  });
}

/* ---------------------------------------------------------- monitores (Super+P) */
let MONS = [], PRIMARY = null, DISP = null;
function setupMonitors(d) {
  if (d !== undefined) DISP = d;
  const W = innerWidth, H = innerHeight;
  let mons = [];
  if (DISP && DISP.available && DISP.bbox && DISP.monitors.length) {
    const bb = DISP.bbox;
    if (Math.abs(W - bb.w) < 24 && Math.abs(H - bb.h) < 24) mons = DISP.monitors.map(m => ({ ...m, x: m.x - bb.x, y: m.y - bb.y }));
  }
  if (!mons.length) mons = [{ name: 'tela', label: 'Tela', x: 0, y: 0, w: W, h: H, primary: true }];
  MONS = mons; PRIMARY = mons.find(m => m.primary) || mons[0];
  const r = document.documentElement.style;
  r.setProperty('--px', PRIMARY.x + 'px'); r.setProperty('--py', PRIMARY.y + 'px');
  r.setProperty('--pw', PRIMARY.w + 'px'); r.setProperty('--ph', PRIMARY.h + 'px');
  Wall.monitors = mons; Wall.dirty = true;
  $$('.mon-label').forEach(e => e.remove());
  mons.filter(m => m !== PRIMARY).forEach((m, i) => {
    const l = el('div', 'mon-label', `<pre class="awave" data-w="20"></pre><b>TELA ${i + 2}</b><small>${esc(m.label)}</small><pre class="mon-clock"></pre>`);
    l.style.left = m.x + m.w - 290 + 'px'; l.style.top = m.y + 26 + 'px';
    document.body.appendChild(l);
  });
}
const DMODES = [
  ['pc', 'Só a tela principal', '┌────┐ ┌────┐\n│▓▓▓▓│ │    │\n└────┘ └────┘'],
  ['duplicate', 'Duplicar', '┌────┐ ┌────┐\n│▓▓▓▓│ │▓▓▓▓│\n└────┘ └────┘'],
  ['extend', 'Estender', '┌────┐┌────┐\n│▓▓▓▓││▒▒▒▒│\n└────┘└────┘'],
  ['second', 'Só a segunda tela', '┌────┐ ┌────┐\n│    │ │▓▓▓▓│\n└────┘ └────┘'],
];
/* painel com os modos (usado no Super+P e em Config → Monitores) */
function displayPanel(box, onDone) {
  const d = DISP || {};
  const cur = d.mode || 'extend';
  const n = (d.connected || []).length;
  box.innerHTML = `<div class="dm-cards">${DMODES.map(([k, l, art]) => `<button class="dm-card${k === cur ? ' cur' : ''}" data-m="${k}"><pre>${art}</pre><span>${l}</span></button>`).join('')}</div>
    <div class="dm-info c-d">${!d.available ? 'O controle de monitores só funciona no NeonOS (aqui é modo de desenvolvimento).'
      : `${n} monitor${n > 1 ? 'es conectados' : ' conectado'}: ${(d.connected || []).map(x => `<span class="${x === d.primary ? 'c-a' : ''}">${esc(x)}${x === d.primary ? ' (principal)' : ''}</span>`).join(' · ')}${n > 1 ? ' · <button class="mini dm-prim">trocar principal</button>' : ''}`}</div>`;
  const cards = $$('.dm-card', box);
  let sel = Math.max(0, DMODES.findIndex(m => m[0] === cur));
  const mark = () => cards.forEach((c, i) => c.classList.toggle('sel', i === sel));
  const go = async i => {
    const mode = DMODES[i][0];
    if (!d.available) return toast('Monitores', 'Disponível só no NeonOS', 'err');
    if (n < 2 && mode !== 'pc') return toast('Só um monitor detectado', 'Conecte outro monitor e tente de novo', 'err');
    onDone && onDone();
    if (mode === d.mode) return;
    toast('Ajustando monitores', DMODES[i][1] + ' — a interface vai reabrir em instantes');
    const r = await api('/api/displays/mode', { mode }).catch(e => ({ error: e.message }));
    if (r.error) toast('Monitores', r.error, 'err');
  };
  cards.forEach((c, i) => { c.onclick = () => go(i); c.onmouseenter = () => { sel = i; mark(); }; });
  if ($('.dm-prim', box)) $('.dm-prim', box).onclick = async () => {
    const others = d.connected.filter(x => x !== d.primary);
    const name = others.length === 1 ? others[0] : await ask({ title: 'Monitor principal', text: 'Nome do monitor: ' + others.join(', '), input: 'text', value: others[0] });
    if (!name) return;
    onDone && onDone();
    const r = await api('/api/displays/primary', { name }).catch(e => ({ error: e.message }));
    r.error ? toast('Monitores', r.error, 'err') : toast('Monitor principal', name + ' — a interface vai reabrir', 'ok');
  };
  mark();
  return { next: () => { sel = (sel + 1) % cards.length; mark(); }, prev: () => { sel = (sel + cards.length - 1) % cards.length; mark(); }, apply: () => go(sel) };
}
async function showDisplayMenu() {
  const open = $('.dmenu');
  if (open) { open._ctl.next(); return; }
  DISP = await api('/api/displays').catch(() => ({ available: false }));
  const m = el('div', 'modal dmenu', `<div class="box"><h3>// PROJETAR</h3><div class="dm-body"></div><p class="c-d" style="font-size:11px">Super+P ou ←/→ escolhe · Enter aplica · Esc fecha</p></div>`);
  document.body.appendChild(m);
  Ascii.scramble($('h3', m), '// PROJETAR', 300); Sfx.open();
  Layer.up(true);
  const close = () => { m.remove(); Layer.down(); document.removeEventListener('keydown', key, true); };
  m._ctl = displayPanel($('.dm-body', m), close);
  const key = e => {
    if (['ArrowRight', 'ArrowDown'].includes(e.key) || (e.metaKey && e.key.toLowerCase() === 'p')) { e.preventDefault(); m._ctl.next(); }
    else if (['ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); m._ctl.prev(); }
    else if (e.key === 'Enter') { e.preventDefault(); m._ctl.apply(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else return;
    e.stopPropagation();
  };
  document.addEventListener('keydown', key, true);
  m.addEventListener('pointerdown', e => { if (e.target === m) close(); });
}
function uiEvent(type, data) {
  if (type === 'drives') { refreshDrives(); bus.emit('drives'); return; }
  if (type === 'fs') { bus.emit('fs'); return; }
  if (type === 'saver-off') { if (Saver.on) Saver.hide(); return; }
  if (type === 'lock') return Lock.show();
  if (Lock.on) return;
  if (type === 'display-menu') showDisplayMenu();
  else if (type === 'start-menu') toggleStart();
  else if (type === 'files') openApp('files');
  else if (type === 'terminal') openApp('terminal');
  else if (type === 'tasks') openApp('tasks');
  else if (type === 'saver') { if (!Saver.on) Saver.show(SETTINGS.saverFx); }
  else if (type === 'open' && data) data.app ? openApp(data.app, data.path) : openPath(data.path);
}
/* tempos de protetor de tela e bloqueio valem para o sistema todo (swayidle) */
const syncIdle = throttle(() => { if (SYS.idle) api('/api/power/settings', { saver: +SETTINGS.saver || 0, lock: +SETTINGS.lockIdle || 0 }).catch(() => {}); }, 1500);

/* aviso de atualizações (a lista do apt é renovada todo dia pelo próprio Debian) */
async function checkUpdates() {
  const open = () => openApp('settings', 'upd');
  try {
    const d = await api('/api/updates');
    if (d.count > 0) toast(`${d.count} atualizaç${d.count > 1 ? 'ões' : 'ão'} do Debian`, 'Clique para ver e atualizar', 'info', open);
  } catch {}
  try {
    const n = await api('/api/neon/check');
    if (n.newer) toast(`NeonOS ${n.remote} disponível`, `Você está na ${n.version}. Clique para atualizar`, 'ok', open);
  } catch {}
}

async function start() {
  Ascii.init(); Wall.init(); applySettings(); Lock.init();
  const ok = connectBackend();
  await bootScreen();
  if (!await ok) {
    // backend ainda subindo (PC lento ou boot pesado): continua tentando em vez de desistir
    toast('Conectando ao sistema…', 'O backend ainda está iniciando', 'info');
    while (!await connectBackend()) await sleep(1000);
  }
  $('#lock .user').textContent = `${SYS.user}@${SYS.host || 'neon'}`.toUpperCase();
  setupMonitors(await api('/api/displays').catch(() => ({ available: false })));
  addEventListener('resize', () => setupMonitors());
  setInterval(() => $$('.mon-clock').forEach(c => c.textContent = Ascii.big(new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }))), 1000);
  buildDesktop(); buildStart(); trayInit(); refreshNetIcon(); pollStats(); pollEvents(); refreshNative(); refreshDrives();
  loadApps().then(() => { buildDesktop(); renderAllApps(); });
  const sShow = Saver.show.bind(Saver), sHide = Saver.hide.bind(Saver);
  Saver.show = fx => { Layer.up(true); sShow(fx); };
  Saver.hide = () => { sHide(); Layer.down(); };
  syncIdle(); bus.on('settings', syncIdle);
  $('#desktop').oncontextmenu = e => {
    if (e.target.closest('.icon')) return;
    e.preventDefault();
    ctxMenu(e.clientX, e.clientY, [
      { label: 'Abrir terminal', fn: () => openApp('terminal') },
      { label: 'Abrir arquivos', fn: () => openApp('files') },
      { label: 'Papel de parede e cores…', fn: () => openApp('settings', 'look') },
      { label: 'Monitores (Super+P)…', fn: () => showDisplayMenu() },
      { label: 'Configurações', fn: () => openApp('settings') }]);
  };
  api('/api/audio').then(setVolIcon).catch(() => {});
  $('#startBtn').onclick = e => { e.stopPropagation(); toggleStart(); };
  document.addEventListener('pointerdown', e => { if (!e.target.closest('#startMenu') && !e.target.closest('#startBtn') && !e.target.closest('.ctx')) closeStart(); });
  Ascii.wordmark();
  $('.wordmark small').textContent = `v${SYS.version} · LINUX · KERNEL GHOST`;
  setTimeout(checkUpdates, 20000); setInterval(checkUpdates, 6 * 3600 * 1000);
  if (SETTINGS.lockOnBoot) Lock.show();
  else toast(`Bem-vindo, ${SYS.user}`, 'Tecla Windows abre o menu · Super+E arquivos · Print captura a tela · Ctrl+Shift+Esc tarefas', 'ok');
}
