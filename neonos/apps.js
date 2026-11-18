'use strict';
/* =====================================================================
   NeonOS — aplicativos
   ===================================================================== */
const APPS = {};
const DESK = ['terminal', 'files', 'browser', 'steam', 'store', 'player', 'hud', 'lab', 'programs', 'settings', 'installer'];
const ghostEmpty = msg => `<div class="empty-msg"><pre class="ghost-art">${esc(Ascii.GHOST)}</pre>${esc(msg)}</div>`;

const MEDIA_RE = /\.(mp3|ogg|opus|flac|wav|m4a|aac|mp4|webm|mkv|mov)$/i;
const VIDEO_RE = /\.(mp4|webm|mkv|mov)$/i;
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const joinP = (a, b) => (a === '/' ? '' : a.replace(/\/$/, '')) + '/' + b;
const parentP = p => p.replace(/\/[^/]+\/?$/, '') || '/';
const baseP = p => p.split('/').filter(Boolean).pop() || '/';
const rawURL = p => '/api/fs/raw?' + qs({ path: p });
function openPath(path) {
  if (MEDIA_RE.test(path)) openApp('player', path);
  else if (IMG_RE.test(path)) openApp('viewer', path);
  else openApp('editor', path);
}
async function watchJob(id, pre) {
  if (pre) { pre.classList.add('on'); pre.textContent = ''; }
  for (;;) {
    const j = await api('/api/jobs?' + qs({ id }));
    if (j.error) return j;
    if (pre) { pre.textContent = j.log || '…'; pre.scrollTop = pre.scrollHeight; }
    if (j.done) return j;
    await sleep(1000);
  }
}

/* ------------------------------------------------------------ Terminal (bash real via PTY) */
function xtermTheme() {
  const a = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00f0ff';
  return { background: '#070912', foreground: '#cfe9ff', cursor: a, cursorAccent: '#070912', selectionBackground: '#ff2a6d66',
    black: '#0b0d17', red: '#ff2a6d', green: '#39ff14', yellow: '#f5e663', blue: '#00a2ff', magenta: '#b967ff', cyan: '#00f0ff', white: '#cfe9ff',
    brightBlack: '#5d7a99', brightRed: '#ff5c8a', brightGreen: '#7dff5c', brightYellow: '#fff38a', brightBlue: '#5cc4ff', brightMagenta: '#d29bff', brightCyan: '#7af7ff', brightWhite: '#ffffff' };
}
APPS.terminal = { name: 'Terminal', icon: '❯_', w: 700, h: 430, async mount(body, ctx, opt = {}) {
  body.classList.add('xt');
  const host = el('div', 'xt-host'); body.appendChild(host);
  const term = new Terminal({ fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, theme: xtermTheme() });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host);
  await sleep(40); try { fit.fit(); } catch {}
  const r = await api('/api/pty/new', { cols: term.cols, rows: term.rows, cwd: opt.cwd, cmd: opt.cmd }).catch(() => ({}));
  if (!r.id) { term.write('\x1b[31mfalha ao abrir o bash\x1b[0m'); return; }
  const id = r.id; let alive = true, buf = '', flushing = false;
  if (opt.cmd) ctx.setTitle('Terminal · ' + opt.cmd.split(' ')[0]);
  else if (Ascii.on() && term.cols >= 56) {
    const G = [[0, 240, 255], [50, 200, 255], [110, 150, 255], [170, 110, 235], [220, 70, 180], [255, 42, 109]];
    const rows = Ascii.LOGO.split('\n');
    for (let i = 0; i < rows.length; i++) { const [r_, g_, b_] = G[i]; term.write(`\x1b[38;2;${r_};${g_};${b_}m${rows[i]}\x1b[0m\r\n`); if (Ascii.full()) await sleep(40); }
    term.write(`\x1b[38;2;93;122;153m ${SYS.os} · ${SYS.kernel} · ${SYS.shell}\x1b[0m\r\n`);
    term.write(`\x1b[38;2;245;230;99m dica:\x1b[0m digite \x1b[38;2;0;240;255mneon\x1b[0m para ver as animações no terminal\r\n\r\n`);
  }
  const flush = async () => { flushing = true; while (buf) { const d = buf; buf = ''; await api('/api/pty/write', { id, data: d }).catch(() => {}); } flushing = false; };
  term.onData(d => { buf += d; if (!flushing) flush(); });
  term.onTitleChange(t => t && ctx.setTitle('Terminal · ' + t));
  (async () => {
    while (alive) {
      try {
        const x = await api('/api/pty/read?' + qs({ id }));
        if (x.exit) { alive = false; term.write('\r\n\x1b[35m[sessão encerrada]\x1b[0m'); setTimeout(ctx.close, 700); }
        else if (x.data) term.write(x.data);
      } catch { await sleep(800); }
    }
  })();
  const ro = new ResizeObserver(throttle(() => { if (!body.offsetWidth) return; try { fit.fit(); api('/api/pty/resize', { id, cols: term.cols, rows: term.rows }); } catch {} }, 120));
  ro.observe(body);
  body.addEventListener('pointerdown', () => setTimeout(() => term.focus()));
  ctx.onClose(bus.on('settings', () => term.options.theme = xtermTheme()));
  ctx.onClose(() => { alive = false; ro.disconnect(); api('/api/pty/close', { id }); term.dispose(); });
  term.focus();
}};

/* ------------------------------------------------------------ Arquivos (disco real) */
APPS.files = { name: 'Arquivos', icon: '▤', w: 700, h: 440, mount(body, ctx, start) {
  let cwd = start || SYS.home, hidden = false;
  const H = SYS.home, places = [['⌂ Início', H], ['▰ Documentos', H + '/Documentos'], ['⇣ Downloads', H + '/Downloads'], ['♫ Música', H + '/Música'],
    ['▶ Vídeos', H + '/Vídeos'], ['▣ Imagens', H + '/Imagens'], ['✕ Lixeira', H + '/.local/share/Trash/files'], ['/ Raiz', '/']];
  body.innerHTML = `<div class="fm"><div class="fm-path"><button class="mini up" title="Pasta acima">↑</button><input class="field" spellcheck="false">
    <button class="mini nd" title="Nova pasta">+▰</button><button class="mini nf" title="Novo arquivo">+≡</button><button class="mini hd" title="Mostrar ocultos">.*</button><button class="mini tm" title="Abrir terminal aqui">❯_</button></div>
    <div class="fm-side">${places.map(([l, p]) => `<button data-p="${esc(p)}">${esc(l)}</button>`).join('')}</div><div class="fm-grid"></div></div>`;
  const grid = $('.fm-grid', body), inp = $('.fm-path input', body);
  let shownPath = null;
  async function render() {
    if (shownPath !== cwd) grid.innerHTML = `<div class="c-d" style="grid-column:1/-1">${Ascii.loading('lendo setores')}</div>`;
    const r = await api('/api/fs/list?' + qs({ path: cwd, hidden: hidden ? 1 : '' })).catch(e => ({ error: e.message }));
    if (r.error) { toast('Não foi possível abrir', r.error, 'err'); if (cwd !== H) { cwd = H; render(); } return; }
    const fresh = shownPath !== r.path;
    cwd = shownPath = r.path; inp.value = cwd; ctx.setTitle('Arquivos · ' + baseP(cwd)); grid.innerHTML = '';
    if (!r.items.length) grid.innerHTML = ghostEmpty('pasta vazia — nada por aqui além de fantasmas');
    let n = 0;
    for (const it of r.items) {
      const p = joinP(cwd, it.name), media = !it.dir && (MEDIA_RE.test(it.name) || IMG_RE.test(it.name));
      const d = el('div', `fm-item ${it.dir ? 'dir' : media ? 'file media' : 'file'}`, `<div class="g">${it.dir ? '▰' : IMG_RE.test(it.name) ? '▣' : MEDIA_RE.test(it.name) ? '♫' : '≡'}</div><span class="nm"></span>`);
      const nm = $('.nm', d);
      if (fresh && n++ < 40 && Ascii.full()) { nm.textContent = it.name.replace(/\S/g, '░'); setTimeout(() => Ascii.scramble(nm, it.name, 300), n * 14); }
      else nm.textContent = it.name;
      d.title = it.dir ? it.name : `${it.name} · ${fmtSize(it.size)}`;
      d.ondblclick = () => { if (it.dir) { cwd = p; render(); } else openPath(p); };
      d.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); ctxMenu(e.clientX, e.clientY, [
        { label: 'Abrir', fn: () => d.ondblclick() },
        ...(!it.dir ? [{ label: 'Abrir no editor', fn: () => openApp('editor', p) }] : [{ label: 'Abrir terminal aqui', fn: () => openApp('terminal', { cwd: p }) }]),
        { label: 'Renomear…', fn: async () => { const n = await ask({ title: 'Renomear', input: 'text', value: it.name, ok: 'Renomear' }); if (n && n !== it.name) { const x = await api('/api/fs/rename', { path: p, name: n }); x.error ? toast('Erro', x.error, 'err') : bus.emit('fs'); } } },
        { label: cwd.includes('/.local/share/Trash') ? 'Apagar definitivamente' : 'Mover para a lixeira', danger: true, fn: async () => {
          if (cwd.includes('/.local/share/Trash') && !await ask({ title: 'Apagar de vez?', text: `"${it.name}" será apagado permanentemente.`, ok: 'Apagar', danger: true })) return;
          const x = await api('/api/fs/trash', { path: p }); x.error ? toast('Erro', x.error, 'err') : bus.emit('fs'); } },
      ]); };
      grid.appendChild(d);
    }
  }
  const create = async kind => {
    const n = await ask({ title: kind === 'dir' ? 'Nova pasta' : 'Novo arquivo', input: 'text', value: kind === 'dir' ? 'nova pasta' : 'novo.txt', ok: 'Criar' });
    if (!n) return;
    const x = await api(kind === 'dir' ? '/api/fs/mkdir' : '/api/fs/touch', { path: joinP(cwd, n) });
    x.error ? toast('Erro', x.error, 'err') : bus.emit('fs');
  };
  $('.up', body).onclick = () => { cwd = parentP(cwd); render(); };
  $('.nd', body).onclick = () => create('dir');
  $('.nf', body).onclick = () => create('file');
  $('.hd', body).onclick = () => { hidden = !hidden; $('.hd', body).classList.toggle('c-a', hidden); render(); };
  $('.tm', body).onclick = () => openApp('terminal', { cwd });
  $$('.fm-side button', body).forEach(b => b.onclick = () => { cwd = b.dataset.p; render(); });
  inp.onkeydown = e => { if (e.key === 'Enter') { cwd = inp.value.trim() || H; render(); } };
  grid.oncontextmenu = e => { if (e.target !== grid) return; e.preventDefault(); ctxMenu(e.clientX, e.clientY, [
    { label: 'Nova pasta…', fn: () => create('dir') }, { label: 'Novo arquivo…', fn: () => create('file') }, { label: 'Abrir terminal aqui', fn: () => openApp('terminal', { cwd }) }]); };
  ctx.onClose(bus.on('fs', render));
  ctx.onArg = p => { cwd = p; render(); };
  render();
}};

/* ------------------------------------------------------------ Editor de texto */
APPS.editor = { name: 'Editor', icon: '✎', w: 600, h: 440, async mount(body, ctx, path) {
  body.innerHTML = `<div class="ed"><div class="tools"><button class="btn sv">Salvar</button><button class="btn sa">Salvar como…</button><span></span></div><textarea spellcheck="false"></textarea></div>`;
  const ta = $('textarea', body), st = $('.tools span', body);
  let dirty = false;
  const label = m => { st.textContent = (path || 'sem título') + (m ? ' · ' + m : ''); ctx.setTitle('Editor · ' + (path ? baseP(path) : 'sem título') + (dirty ? ' ●' : '')); };
  if (path) {
    const r = await api('/api/fs/read?' + qs({ path })).catch(e => ({ error: e.message }));
    if (r.error) { toast('Não foi possível abrir', r.error, 'err'); path = null; }
    else { ta.value = r.content; if (r.binary) label('arquivo binário — cuidado ao salvar'); }
  }
  label();
  const save = async (as = false) => {
    if (!path || as) {
      const p = await ask({ title: 'Salvar como', input: 'text', value: path || SYS.home + '/Documentos/nota.txt', ok: 'Salvar' });
      if (!p) return; path = p;
    }
    const r = await api('/api/fs/write', { path, content: ta.value });
    if (r.error) return toast('Erro ao salvar', r.error, 'err');
    path = r.path; dirty = false; label('salvo ✓'); Sfx.click(); bus.emit('fs');
  };
  $('.sv', body).onclick = () => save();
  $('.sa', body).onclick = () => save(true);
  ta.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('    ', s, ta.selectionEnd, 'end'); dirty = true; label('modificado'); }
  });
  ta.addEventListener('input', () => { if (!dirty) { dirty = true; label('modificado'); } });
  setTimeout(() => ta.focus(), 50);
}};

/* ------------------------------------------------------------ Visualizador de imagem */
APPS.viewer = { name: 'Imagem', icon: '▣', w: 640, h: 460, mount(body, ctx, path) {
  ctx.setTitle('Imagem · ' + baseP(path || ''));
  body.innerHTML = `<div class="viewer"><img alt=""></div>`;
  $('img', body).src = rawURL(path);
}};

/* ------------------------------------------------------------ Navegador (Firefox) */
APPS.browser = { name: 'Navegador', icon: '◎', w: 620, h: 400, single: true, mount(body) {
  const LINKS = [['⌕', 'DuckDuckGo', 'https://duckduckgo.com'], ['W', 'Wikipédia', 'https://pt.wikipedia.org'], ['▶', 'YouTube', 'https://youtube.com'],
    ['⌥', 'GitHub', 'https://github.com'], ['◉', 'Debian', 'https://www.debian.org/index.pt.html'], ['☰', 'Notícias', 'https://news.google.com/?hl=pt-BR']];
  body.innerHTML = `<div class="br"><div><h5 class="c-h" style="margin:0 0 8px;font-weight:400;letter-spacing:2px">// NAVEGAR NA REDE</h5>
    <form><input class="field" placeholder="digite um endereço ou pesquise…" spellcheck="false"><button class="btn">Ir</button></form></div>
    <div class="links">${LINKS.map(([i, n, u]) => `<button data-u="${u}"><i>${i}</i>${n}</button>`).join('')}</div>
    <div><button class="btn op">Abrir Firefox</button> <small class="c-d">&nbsp;Super+B também abre · Alt+Tab troca de janela · Super+Espaço volta ao NeonOS</small></div></div>`;
  const go = async url => {
    const r = await api('/api/browser', url ? { url } : {}).catch(() => ({}));
    if (r.available === false) window.open(url || 'https://duckduckgo.com', '_blank');
    else toast('Abrindo navegador', url || '');
  };
  $('form', body).onsubmit = e => {
    e.preventDefault(); const v = $('input', body).value.trim(); if (!v) return;
    go(/^[a-z]+:\/\//i.test(v) ? v : /^[^\s]+\.[^\s]{2,}$/.test(v) ? 'https://' + v : 'https://duckduckgo.com/?q=' + encodeURIComponent(v));
  };
  $$('.links button', body).forEach(b => b.onclick = () => go(b.dataset.u));
  $('.op', body).onclick = () => go();
  setTimeout(() => $('input', body).focus(), 50);
}};

/* ------------------------------------------------------------ Steam */
APPS.steam = {
  name: 'Steam', icon: '⊛',
  svg: `<svg class="ico" viewBox="0 0 32 32"><path d="M9.5 10h13a6 6 0 0 1 5.8 4.5l1.7 7.4a3.3 3.3 0 0 1-5.8 2.9L21.4 21H10.6l-2.8 3.8A3.3 3.3 0 0 1 2 21.9l1.7-7.4A6 6 0 0 1 9.5 10z"/><path d="M10 13.6v4.8M7.6 16h4.8"/><circle cx="21.2" cy="14.6" r="1.1" fill="currentColor"/><circle cx="24.4" cy="17.4" r="1.1" fill="currentColor"/><path d="M14.4 13.2h3.2" opacity=".55"/><path d="M12 6.5l2 2M20 6.5l-2 2" opacity=".55"/></svg>`,
  async launch() {
    const r = await api('/api/apps/launch', { id: 'steam.desktop' }).catch(() => ({ error: 'sem resposta do backend' }));
    if (r.ok) toast('Abrindo a Steam', 'Na primeira vez ela baixa a própria atualização (~300 MB) e pede para você entrar na conta');
    else toast('Steam não encontrada', 'Clique para instalar pela Loja', 'err', () => openApp('store', 'steam-installer'));
  }
};

/* ------------------------------------------------------------ Loja de apps (apt) */
const FEATURED = [
  ['vlc', 'VLC', 'Toca qualquer vídeo ou música'], ['gimp', 'GIMP', 'Editor de imagens'], ['libreoffice', 'LibreOffice', 'Textos, planilhas e apresentações'],
  ['inkscape', 'Inkscape', 'Desenho vetorial'], ['krita', 'Krita', 'Pintura digital'], ['obs-studio', 'OBS Studio', 'Gravar a tela e fazer lives'],
  ['audacity', 'Audacity', 'Editar áudio'], ['thunderbird', 'Thunderbird', 'E-mail'], ['transmission-gtk', 'Transmission', 'Torrents'],
  ['btop', 'btop', 'Monitor de sistema no terminal'], ['neovim', 'Neovim', 'Editor de código no terminal'], ['cmatrix', 'cmatrix', 'Chuva de código no terminal'],
];
APPS.store = { name: 'Loja', icon: '⬡', w: 760, h: 500, single: true, mount(body, ctx, start) {
  body.innerHTML = `<div class="st"><div class="st-top"><input class="field" placeholder="buscar programas do Debian…" spellcheck="false"><button class="btn bs">Buscar</button><button class="btn up" title="Baixar a lista atual de programas">Atualizar índice</button></div>
    <div class="st-scroll"><div class="st-head">// DESTAQUES</div><div class="st-list"></div></div><pre class="log"></pre></div>`;
  const list = $('.st-list', body), head = $('.st-head', body), log = $('.log', body), inp = $('input', body);
  let busy = false;
  const card = (name, title, desc, installed) => {
    const c = el('div', 'card' + (installed ? ' inst' : ''), `<b>${esc(title)}</b><small>${esc(name)}</small><small>${esc(desc)}</small>
      <button class="btn ${installed ? 'hot' : ''}">${installed ? 'Remover' : 'Instalar'}</button>`);
    $('button', c).onclick = () => act(installed ? 'remove' : 'install', name, title, c);
    c.onmouseenter = () => Ascii.scramble($('b', c), title, 250);
    return c;
  };
  async function featured() {
    head.textContent = '// DESTAQUES';
    const st = (await api('/api/store/status?' + qs({ pkgs: FEATURED.map(f => f[0]).join(',') })).catch(() => ({}))).status || {};
    list.innerHTML = ''; FEATURED.forEach(([n, t, d]) => list.appendChild(card(n, t, d, st[n])));
  }
  async function search() {
    const q = inp.value.trim(); if (!q) return featured();
    head.textContent = `// RESULTADOS PARA "${q}"`; list.innerHTML = `<div class="c-d">${Ascii.loading('consultando repositórios')}</div>`;
    const r = await api('/api/store/search?' + qs({ q })).catch(() => ({ items: [] }));
    if (r.available === false) { list.innerHTML = '<div class="c-d">O apt não está disponível neste sistema.</div>'; return; }
    list.innerHTML = r.items.length ? '' : '<div class="c-d">Nada encontrado. Tente "Atualizar índice".</div>';
    r.items.forEach(i => list.appendChild(card(i.name, i.name, i.desc, i.installed)));
  }
  async function act(action, pkg, title, cardEl) {
    if (busy) return toast('Aguarde', 'Já existe uma instalação em andamento');
    if (action === 'remove' && !await ask({ title: `Remover ${title}?`, ok: 'Remover', danger: true })) return;
    busy = true; $$('button', body).forEach(b => b.disabled = true);
    const r = await rootCall('/api/store/' + action, { pkg });
    if (r && r.job) {
      toast(action === 'install' ? 'Instalando' : action === 'remove' ? 'Removendo' : 'Atualizando', title || '');
      const btn = cardEl && $('button', cardEl);
      if (btn) btn.outerHTML = `<div class="c-a" style="margin-top:6px">${Ascii.bar(14)}</div>`;
      else head.innerHTML = `${esc(head.textContent)} &nbsp;${Ascii.bar(14)}`;
      await watchJob(r.job, log);
    }
    busy = false; $$('button', body).forEach(b => b.disabled = false);
    inp.value.trim() ? search() : featured();
  }
  $('.bs', body).onclick = search;
  inp.onkeydown = e => { if (e.key === 'Enter') search(); };
  $('.up', body).onclick = () => act('update', '', 'índice de programas');
  ctx.onArg = q => { if (q) { inp.value = q; search(); } };
  if (start) { inp.value = start; search(); } else featured();
}};

/* ------------------------------------------------------------ Programas instalados */
APPS.programs = { name: 'Programas', icon: '⊞', w: 680, h: 460, single: true, mount(body) {
  body.innerHTML = `<div class="pg"><div class="pg-top"><input class="field" placeholder="filtrar programas…" spellcheck="false"></div><div class="pg-grid"><div class="c-d">${Ascii.loading('indexando programas')}</div></div></div>`;
  const grid = $('.pg-grid', body), inp = $('input', body);
  let apps = [];
  const render = () => {
    const f = inp.value.toLowerCase();
    const shown = apps.filter(a => !f || a.name.toLowerCase().includes(f) || a.comment.toLowerCase().includes(f));
    grid.innerHTML = shown.length ? '' : ghostEmpty('Nenhum programa encontrado. Instale alguns na Loja.');
    shown.forEach(a => {
      const b = el('button', '', `<b>${esc(a.name)}</b><small>${esc(a.comment || (a.terminal ? 'programa de terminal' : ''))}</small>`);
      b.onclick = async () => {
        const r = await api('/api/apps/launch', { id: a.id });
        if (r.error) return toast('Erro', r.error, 'err');
        if (r.terminal) openApp('terminal', { cmd: r.terminal }); else toast('Abrindo', a.name);
      };
      grid.appendChild(b);
    });
  };
  inp.oninput = render;
  api('/api/apps').then(r => { apps = r.apps || []; render(); });
  setTimeout(() => inp.focus(), 50);
}};

/* ------------------------------------------------------------ Player de música e vídeo */
APPS.player = { name: 'Player', icon: '♫', w: 780, h: 480, single: true, mount(body, ctx, path) {
  body.innerHTML = `<div class="pl"><aside><div class="pl-h">PLAYLIST <button class="mini rf" title="Procurar de novo">↻</button></div><div class="pl-list"></div></aside>
    <main><div class="stage"><video playsinline></video><canvas></canvas><div class="np">— nada tocando —</div></div>
    <div class="ctrl"><button class="pv" title="Anterior">⏮</button><button class="pp" title="Tocar/pausar">▶</button><button class="nx" title="Próxima">⏭</button><button class="az" title="Visualizador ASCII">▤</button>
    <span class="tm">0:00</span><input type="range" class="sk" min="0" max="1000" value="0"><span class="du">0:00</span><input type="range" class="vl" min="0" max="100" value="85" title="Volume"></div></main></div>`;
  const v = $('video', body), cv = $('canvas', body), g = cv.getContext('2d'), stage = $('.stage', body), lst = $('.pl-list', body);
  let items = [], idx = -1, analyser = null, raf = 0, seeking = false;
  v.volume = .85;
  const renderList = () => {
    lst.innerHTML = items.length ? '' : `<div class="empty"><pre class="ghost-art" style="font-size:10px;margin:8px 0">${esc(Ascii.GHOST)}</pre>Coloque músicas e vídeos em ~/Música, ~/Vídeos ou ~/Downloads, ou abra um arquivo pelo app Arquivos.</div>`;
    items.forEach((it, i) => { const b = el('button', i === idx ? 'on' : '', `${it.video ? '▶' : '♫'} ${esc(it.name)}`); b.title = it.path; b.onclick = () => play(i); lst.appendChild(b); });
  };
  const ensureViz = () => {
    if (analyser) return;
    try { const c = Sfx.ac(), src = c.createMediaElementSource(v); analyser = c.createAnalyser(); analyser.fftSize = 128; src.connect(analyser); analyser.connect(c.destination); } catch {}
  };
  const play = i => {
    if (!items[i]) return;
    idx = i; const it = items[i];
    stage.classList.toggle('video', it.video);
    v.src = rawURL(it.path); ensureViz(); v.play().catch(() => {});
    $('.np', body).textContent = '▶ ' + it.name; ctx.setTitle('Player · ' + it.name); renderList();
  };
  const add = p => { let i = items.findIndex(x => x.path === p); if (i < 0) { items.unshift({ path: p, name: baseP(p), video: VIDEO_RE.test(p) }); i = 0; } renderList(); play(i); };
  const scan = async () => { const r = await api('/api/media/scan').catch(() => ({ items: [] })); const keep = items.filter(x => !r.items.some(y => y.path === x.path)); items = [...keep, ...r.items]; if (idx >= items.length) idx = -1; renderList(); };
  let asciiViz = Ascii.on(), scr = null;
  const peaks = [];
  $('.az', body).classList.toggle('on', asciiViz);
  $('.az', body).onclick = e => { asciiViz = !asciiViz; e.currentTarget.classList.toggle('on', asciiViz); scr = null; };
  const draw = () => {
    raf = requestAnimationFrame(draw);
    if (stage.classList.contains('video') || !cv.clientWidth) return;
    const data = new Uint8Array(64); if (analyser && !v.paused) analyser.getByteFrequencyData(data);
    if (asciiViz) {
      if (!scr || scr.changed()) scr = new AsciiScreen(cv, { size: 13 });
      scr.clear();
      const C = scr.cols, R = scr.rows, pal = Ascii.grad(Math.max(2, R), Ascii.hot, Ascii.acc), t = performance.now() / 1000, playing = analyser && !v.paused;
      for (let x = 0; x < C; x++) {
        const val = playing ? data[Math.min(63, x * 46 / C | 0)] / 255 : (Math.sin(x * .22 + t * 2.2) * .5 + .5) * .14 + .02;
        const h = val * (R - 3);
        peaks[x] = Math.max((peaks[x] || 0) - .2, h);
        for (let y = 0; y < h; y++) scr.put(x, R - 1 - y, y + 1 > h ? '▄' : (x % 2 ? '█' : '▓'), pal[Math.min(R - 1, y)]);
        if (peaks[x] > 1) scr.put(x, R - 2 - Math.round(peaks[x]), '▀', Ascii.warn);
      }
      if (!playing) scr.text(2, 1, '▸ aguardando sinal…', Ascii.tint(Ascii.acc, .5));
      scr.render('#000');
      return;
    }
    scr = null;
    const W = cv.width = cv.clientWidth, H = cv.height = cv.clientHeight;
    const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    g.clearRect(0, 0, W, H);
    const bw = W / data.length;
    data.forEach((val, i) => {
      const h = Math.max(2, val / 255 * H * .75), x = i * bw;
      const grad = g.createLinearGradient(0, H, 0, H - h); grad.addColorStop(0, '#ff2a6d'); grad.addColorStop(1, acc);
      g.fillStyle = grad; g.fillRect(x + 2, H - h, bw - 4, h);
      g.globalAlpha = .15; g.fillRect(x + 2, 0, bw - 4, h * .3); g.globalAlpha = 1;
    });
  };
  $('.pp', body).onclick = () => { if (idx < 0 && items.length) return play(0); v.paused ? v.play() : v.pause(); };
  $('.nx', body).onclick = () => items.length && play((idx + 1) % items.length);
  $('.pv', body).onclick = () => items.length && play((idx - 1 + items.length) % items.length);
  $('.rf', body).onclick = scan;
  $('.vl', body).oninput = e => v.volume = e.target.value / 100;
  const sk = $('.sk', body);
  sk.oninput = () => { seeking = true; }; sk.onchange = () => { if (v.duration) v.currentTime = sk.value / 1000 * v.duration; seeking = false; };
  v.onplay = () => $('.pp', body).textContent = '❚❚';
  v.onpause = () => $('.pp', body).textContent = '▶';
  v.onended = () => $('.nx', body).click();
  v.onerror = () => toast('Formato não suportado', items[idx]?.name || '', 'err');
  v.ontimeupdate = () => { $('.tm', body).textContent = fmtTime(v.currentTime); $('.du', body).textContent = fmtTime(v.duration); if (!seeking && v.duration) sk.value = v.currentTime / v.duration * 1000; };
  ctx.onArg = p => p && add(p);
  ctx.onClose(() => { cancelAnimationFrame(raf); v.pause(); v.removeAttribute('src'); v.load(); });
  draw();
  scan().then(() => path && add(path));
}};

/* ------------------------------------------------------------ Implante (painel de status) */
APPS.hud = { name: 'Implante', icon: '◈', w: 900, h: 600, single: true, mount(body, ctx) {
  const G = [['cpu', 'CPU'], ['ram', 'MEMÓRIA'], ['disk', 'DISCO'], ['temp', 'TEMPERATURA'], ['bat', 'BATERIA']];
  body.innerHTML = `<div class="hud">
    <div class="hud-top"><div><small>HOST</small><b class="h-host"></b></div><div><small>SISTEMA</small><b class="h-os"></b></div><div><small>KERNEL</small><b class="h-k"></b></div><div><small>ATIVO HÁ</small><b class="h-up"></b></div><div><small>CARGA</small><b class="h-ld"></b></div></div>
    <div class="gauges">${G.map(([k, l]) => `<div class="gauge" data-k="${k}"><div class="ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="50" class="trk"/><circle cx="60" cy="60" r="50" class="val"/></svg><b>--</b></div><small>${l}</small><pre class="gbar">${Ascii.meter(0)}</pre></div>`).join('')}</div>
    <div class="hud-mid"><div class="hud-radar"><div class="lbl">VARREDURA DE SINAIS</div><canvas></canvas></div>
    <div class="hud-net"><div class="lbl">REDE &nbsp; <span class="rx">▼ 0</span> &nbsp; <span class="tx">▲ 0</span></div><canvas></canvas></div></div>
    <div><div class="lbl" style="margin-bottom:6px">PROCESSOS (MAIS MEMÓRIA)</div><table><thead><tr><th>PID</th><th>PROCESSO</th><th>MEMÓRIA</th></tr></thead><tbody></tbody></table></div></div>`;
  $('.h-host', body).textContent = `${SYS.user}@${SYS.host}`; $('.h-os', body).textContent = SYS.os; $('.h-k', body).textContent = SYS.kernel;
  const cv = $('.hud-net canvas', body), g = cv.getContext('2d'), rx = Array(90).fill(0), tx = Array(90).fill(0);
  const radar = asciiLoop($('.hud-radar canvas', body), 'radar', { size: 11, bg: null });
  ctx.onClose(() => radar.stop());
  const rate = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB/s' : (b / 1024).toFixed(0) + ' KB/s';
  const setG = (k, pct, txt, hot) => { const gg = $(`.gauge[data-k="${k}"]`, body); if (!gg) return; $('.val', gg).style.strokeDashoffset = 314.16 * (1 - Math.max(0, Math.min(1, pct))); $('b', gg).textContent = txt; gg.classList.toggle('hot', !!hot); $('.gbar', gg).textContent = Ascii.meter(pct); };
  const upd = s => {
    $('.h-up', body).textContent = fmtUp(s.uptime); $('.h-ld', body).textContent = s.load != null ? `${s.load} · ${s.cores} núcleos` : '--';
    setG('cpu', s.cpu / 100, Math.round(s.cpu) + '%', s.cpu > 85);
    const mp = s.mem_total ? s.mem_used / s.mem_total : 0; setG('ram', mp, s.mem_total ? Math.round(mp * 100) + '%' : '--', mp > .9);
    const dp = s.disk ? s.disk.used / s.disk.total : 0; setG('disk', dp, s.disk ? Math.round(dp * 100) + '%' : '--', dp > .9);
    setG('temp', s.temp ? s.temp / 100 : 0, s.temp ? Math.round(s.temp) + '°' : '--', s.temp > 80);
    setG('bat', s.battery ? s.battery.level / 100 : 0, s.battery ? s.battery.level + '%' : 'AC', s.battery && s.battery.level < 15);
    rx.push(RATES.rx); rx.shift(); tx.push(RATES.tx); tx.shift();
    $('.rx', body).textContent = '▼ ' + rate(RATES.rx); $('.tx', body).textContent = '▲ ' + rate(RATES.tx);
    const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = cv.clientHeight * devicePixelRatio, max = Math.max(1024, ...rx, ...tx);
    const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    [[rx, acc], [tx, '#ff2a6d']].forEach(([arr, c]) => {
      g.beginPath(); arr.forEach((v, i) => { const x = i / (arr.length - 1) * W, y = H - v / max * H * .9 - 2; i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.strokeStyle = c; g.lineWidth = 1.6 * devicePixelRatio; g.stroke(); g.lineTo(W, H); g.lineTo(0, H); g.closePath(); g.fillStyle = c + '1a'; g.fill();
    });
    $('tbody', body).innerHTML = s.procs.map(p => `<tr><td>${p.pid}</td><td>${esc(p.name)}</td><td>${p.rss} MB</td></tr>`).join('') || '<tr><td colspan="3" class="c-d">indisponível neste sistema</td></tr>';
  };
  if (STATS) upd(STATS);
  ctx.onClose(bus.on('stats', upd));
}};

/* ------------------------------------------------------------ Configurações */
APPS.settings = { name: 'Config', icon: '⚙', w: 680, h: 460, single: true, mount(body, ctx, tab) {
  const TABS = { look: 'Aparência', fx: 'Animações', tela: 'Monitores', sound: 'Som', sec: 'Segurança', upd: 'Atualizações', sys: 'Sistema' };
  body.innerHTML = `<div class="set"><nav>${Object.entries(TABS).map(([k, v]) => `<button data-tab="${k}">${v}</button>`).join('')}</nav><section></section></div>`;
  const sec = $('section', body);
  const R = {
    look() {
      sec.innerHTML = `<div><h5>COR DE DESTAQUE</h5><div class="swatches">${Object.entries(THEMES).map(([k, c]) => `<button data-t="${k}" title="${k}" class="${SETTINGS.theme === k ? 'on' : ''}" style="background:${c}"></button>`).join('')}</div></div>
        <div><h5>PAPEL DE PAREDE ANIMADO</h5><div class="walls">${Object.entries(WALLS).map(([k, v]) => `<button data-w="${k}" class="${SETTINGS.wall === k ? 'on' : ''}">${v}</button>`).join('')}</div><small class="c-d">"Escuro" é o mais leve para computadores fracos.</small></div>
        <div><h5>EFEITOS</h5><label class="row"><input type="checkbox" class="sc" ${SETTINGS.scan ? 'checked' : ''}> Scanlines de monitor CRT</label></div>`;
      $$('[data-t]', sec).forEach(b => b.onclick = () => { SETTINGS.theme = b.dataset.t; saveSettings(); R.look(); });
      $$('[data-w]', sec).forEach(b => b.onclick = () => { SETTINGS.wall = b.dataset.w; saveSettings(); R.look(); });
      $('.sc', sec).onchange = e => { SETTINGS.scan = e.target.checked; saveSettings(); };
    },
    fx() {
      const names = Object.entries(Ascii.FX).filter(([k]) => k !== 'radar');
      sec.innerHTML = `<div><h5>NÍVEL DE ANIMAÇÃO ASCII</h5><div class="fx-pick">${[['full', 'Completo'], ['low', 'Reduzido'], ['off', 'Desligado']].map(([k, l]) => `<button data-lv="${k}" class="${SETTINGS.fx === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <p class="c-d">Completo: textos que decodificam, janelas que se desfazem em blocos, glitches no logo. Reduzido: só os efeitos leves, com metade dos quadros — bom para PCs fracos.</p></div>
        <div><h5>PROTETOR DE TELA ASCII</h5><label class="row">Ativar após: <select class="field sv" style="width:auto">${[[0, 'nunca'], [1, '1 minuto'], [3, '3 minutos'], [5, '5 minutos'], [10, '10 minutos'], [15, '15 minutos']].map(([v, l]) => `<option value="${v}" ${SETTINGS.saver == v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <div class="fx-pick" style="margin-top:8px"><button data-ef="random" class="${SETTINGS.saverFx === 'random' ? 'on' : ''}">Aleatório</button>${names.map(([k, f]) => `<button data-ef="${k}" class="${SETTINGS.saverFx === k ? 'on' : ''}">${f.name}</button>`).join('')}</div>
        <button class="btn tst" style="margin-top:10px">Testar protetor agora</button></div>
        <div><h5>MAIS ASCII</h5><p class="c-d">Abra o <b>ASCII Lab</b> para ver todos os efeitos, escolha um papel de parede "ASCII" em Aparência, ou digite <b>neon</b> no terminal.</p></div>`;
      $$('[data-lv]', sec).forEach(b => b.onclick = () => { SETTINGS.fx = b.dataset.lv; saveSettings(); R.fx(); });
      $('.sv', sec).onchange = e => { SETTINGS.saver = +e.target.value; saveSettings(); };
      $$('[data-ef]', sec).forEach(b => b.onclick = () => { SETTINGS.saverFx = b.dataset.ef; saveSettings(); R.fx(); });
      $('.tst', sec).onclick = () => Saver.show(SETTINGS.saverFx);
    },
    async tela() {
      sec.innerHTML = `<div><h5>MODO DOS MONITORES</h5><div class="dm-body">${Ascii.loading('detectando monitores')}</div></div>
        <div><h5>ATALHO</h5><p class="c-d">Aperte <b>Super+P</b> (tecla Windows + P) em qualquer lugar para trocar rápido, como no Windows.</p>
        <p class="c-d">Em "Estender", cada monitor tem o seu papel de parede, as janelas podem ser arrastadas entre eles, e maximizar ocupa só o monitor da janela. A barra de tarefas fica no monitor principal.</p></div>`;
      DISP = await api('/api/displays').catch(() => ({ available: false }));
      displayPanel($('.dm-body', sec));
    },
    sound() {
      sec.innerHTML = `<div><h5>SONS DA INTERFACE</h5><label class="row"><input type="checkbox" class="sf" ${SETTINGS.sound ? 'checked' : ''}> Bipes ao abrir/fechar janelas, notificações e inicialização</label>
        <div style="display:flex;gap:6px;margin-top:8px"><button class="btn" data-s="open">Abrir</button><button class="btn" data-s="notify">Notificação</button><button class="btn" data-s="error">Erro</button><button class="btn" data-s="boot">Boot</button></div></div>
        <div><h5>AMBIENTE</h5><label class="row"><input type="checkbox" class="am" ${SETTINGS.ambient ? 'checked' : ''}> Zumbido ambiente de fundo (sintetizado)</label></div>
        <div><h5>VOLUME DO SISTEMA</h5><p class="c-d">Use o ícone de som na barra de tarefas.</p></div>`;
      $('.sf', sec).onchange = e => { SETTINGS.sound = e.target.checked; saveSettings(); };
      $('.am', sec).onchange = e => { SETTINGS.ambient = e.target.checked; saveSettings(); };
      $$('[data-s]', sec).forEach(b => b.onclick = () => Sfx[b.dataset.s]());
    },
    sec() {
      sec.innerHTML = `<div><h5>BLOQUEIO DE TELA</h5>
        <label class="row">Bloquear após inatividade: <select class="field li" style="width:auto">${[[0, 'nunca'], [1, '1 minuto'], [5, '5 minutos'], [10, '10 minutos'], [30, '30 minutos']].map(([v, l]) => `<option value="${v}" ${SETTINGS.lockIdle == v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="row"><input type="checkbox" class="lb" ${SETTINGS.lockOnBoot ? 'checked' : ''}> Pedir senha ao iniciar</label>
        <button class="btn ln" style="margin-top:8px">Bloquear agora</button>
        <p class="c-d">A senha é a do usuário <b>${esc(SYS.user)}</b> no Linux${SYS.live || SYS.dev ? ' (no modo live: <b>live</b>)' : ''}. Atalho: Ctrl+Alt+L.</p></div>`;
      $('.li', sec).onchange = e => { SETTINGS.lockIdle = +e.target.value; saveSettings(); };
      $('.lb', sec).onchange = e => { SETTINGS.lockOnBoot = e.target.checked; saveSettings(); };
      $('.ln', sec).onclick = () => Lock.show();
    },
    upd() {
      sec.innerHTML = `<div class="deb"><h5>SISTEMA DEBIAN</h5><div>${Ascii.loading('consultando o apt')}</div></div>
        <div class="neo"><h5>INTERFACE NEONOS</h5><div>${Ascii.loading('verificando versão')}</div></div><pre class="log"></pre>`;
      const log = $('.log', sec);
      const busy = on => $$('button', sec).forEach(b => b.disabled = on);
      const deb = async () => {
        const box = $('.deb > div', sec), d = await api('/api/updates').catch(() => ({ available: false }));
        if (!d.available) { box.innerHTML = '<p class="c-d">O apt não está disponível neste sistema.</p>'; return; }
        const when = d.checked ? new Date(d.checked * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
        box.innerHTML = `<p>${d.count ? `<b class="c-a">${d.count}</b> atualizaç${d.count > 1 ? 'ões disponíveis' : 'ão disponível'}` : '<span class="c-o">✓ tudo em dia</span>'}
          <span class="c-d"> · lista de ${when}</span></p>
          ${d.count ? `<p class="c-d" style="font-size:11px">${d.items.slice(0, 10).map(i => esc(i.name)).join(' · ')}${d.count > 10 ? ` · e mais ${d.count - 10}` : ''}</p>` : ''}
          <div style="display:flex;gap:6px"><button class="btn rf">Procurar agora</button><button class="btn hot ug" ${d.count ? '' : 'disabled'}>Atualizar tudo</button></div>
          <p class="c-d" style="font-size:11px">Kernel, Firefox, drivers e programas. O Debian também procura sozinho uma vez por dia.</p>`;
        $('.rf', box).onclick = async () => { busy(true); const r = await rootCall('/api/updates/refresh'); if (r && r.job) await watchJob(r.job, log); busy(false); deb(); };
        $('.ug', box).onclick = async () => {
          if (!await ask({ title: 'Atualizar o sistema?', text: `${d.count} pacote(s) serão atualizados. Pode levar alguns minutos; não desligue o computador.`, ok: 'Atualizar' })) return;
          busy(true); const r = await rootCall('/api/updates/upgrade');
          if (r && r.job) { const j = await watchJob(r.job, log); if (j.code === 0) toast('Sistema atualizado', d.items.some(i => /^linux-image/.test(i.name)) ? 'O kernel mudou: reinicie para usar o novo' : '', 'ok'); }
          busy(false); deb();
        };
      };
      const neo = async () => {
        const box = $('.neo > div', sec), n = await api('/api/neon/check').catch(() => ({}));
        const repoForm = `<div style="display:flex;gap:6px;margin-top:6px"><input class="field rp" placeholder="usuario/repositorio" spellcheck="false" value="${esc(n.repo || '')}"><input class="field br" style="width:110px" value="${esc(n.branch || 'main')}" spellcheck="false"><button class="btn sv">Salvar</button></div>`;
        let status;
        if (!n.repo) status = `<p class="c-d">Para receber versões novas da interface, informe o repositório do GitHub onde está o código do NeonOS (precisa ser público).</p>${repoForm}`;
        else status = `<p>repositório <b class="c-a">${esc(n.repo)}</b> <span class="c-d">(${esc(n.branch)})</span> · ${n.error ? `<span class="c-h">${esc(n.error)}</span>` : n.newer ? `<span class="c-w">versão ${esc(n.remote)} disponível</span>` : `<span class="c-o">✓ em dia${n.remote ? ` (${esc(n.remote)})` : ''}</span>`}</p>
          <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn ck">Verificar</button><button class="btn hot up" ${n.newer ? '' : 'disabled'}>Atualizar NeonOS</button>
          <button class="btn rb" ${n.backups && n.backups.length ? '' : 'disabled'} title="${esc((n.backups || [])[0] || '')}">Voltar versão anterior</button><button class="btn ed">Trocar repositório</button></div>`;
        box.innerHTML = `<p>versão instalada: <b class="c-a">${esc(n.version || SYS.version)}</b></p>${status}
          ${n.installed === false ? '<p class="c-d" style="font-size:11px">(o neon-update só existe no NeonOS instalado — aqui é modo de desenvolvimento)</p>' : ''}`;
        const save = async () => {
          const r = await rootCall('/api/neon/repo', { repo: $('.rp', box).value.trim(), branch: $('.br', box).value.trim() || 'main' });
          if (r && r.ok) { toast('Repositório salvo', $('.rp', box).value, 'ok'); neo(); } else if (r && r.out) toast('Erro', r.out, 'err');
        };
        if ($('.sv', box)) $('.sv', box).onclick = save;
        if ($('.ck', box)) $('.ck', box).onclick = neo;
        if ($('.ed', box)) $('.ed', box).onclick = () => { $('.ed', box).remove(); box.insertAdjacentHTML('beforeend', repoForm); $('.sv', box).onclick = save; };
        const runNeon = async (path, label) => {
          busy(true); const r = await rootCall(path, {});
          if (r && r.job) {
            const j = await watchJob(r.job, log);
            if (j.code === 0) { toast(label, 'A interface vai reiniciar em instantes', 'ok'); await api('/api/neon/restart', {}).catch(() => {}); await sleep(2500); location.reload(); return; }
          }
          busy(false); neo();
        };
        if ($('.up', box)) $('.up', box).onclick = () => runNeon('/api/neon/update', 'NeonOS atualizado');
        if ($('.rb', box)) $('.rb', box).onclick = async () => { if (await ask({ title: 'Voltar versão?', text: `Restaurar o backup ${n.backups[0]}?`, ok: 'Voltar', danger: true })) runNeon('/api/neon/rollback', 'Versão anterior restaurada'); };
      };
      deb(); neo();
    },
    async sys() {
      sec.innerHTML = `<div><h5>SISTEMA</h5><div class="kv"><span>Sistema</span><span>${esc(SYS.os)}</span><span>Kernel</span><span>${esc(SYS.kernel)}</span><span>Shell</span><span>${esc(SYS.shell)}</span>
        <span>Usuário</span><span>${esc(SYS.user)}@${esc(SYS.host)}</span><span>Modo</span><span>${SYS.live ? 'Live (pendrive)' : 'Instalado'}</span></div></div>
        <div class="ps"><h5>PERSISTÊNCIA</h5><div class="c-d">verificando…</div></div>
        <div><h5>INSTALAÇÃO</h5><button class="btn inst">Instalar no disco…</button></div>`;
      $('.inst', sec).onclick = () => openApp('installer');
      const ps = $('.ps', sec), st = await api('/api/persist').catch(() => ({}));
      if (!st.live) { ps.innerHTML = '<h5>PERSISTÊNCIA</h5><div class="c-d">Este não é o modo live: tudo já fica salvo no disco.</div>'; return; }
      if (st.active) { ps.innerHTML = '<h5>PERSISTÊNCIA</h5><div class="c-o">● Ativa — arquivos, configurações e programas ficam salvos no pendrive.</div>'; return; }
      ps.innerHTML = `<h5>PERSISTÊNCIA</h5><p class="c-d">Hoje tudo é apagado ao desligar. Isto cria uma partição no espaço livre do pendrive para guardar arquivos, configurações e programas instalados.</p>
        <button class="btn hot go">Ativar persistência</button><pre class="log"></pre>`;
      $('.go', ps).onclick = async () => {
        if (!await ask({ title: 'Ativar persistência?', text: 'Será criada uma nova partição no espaço livre do pendrive de boot. Use um pendrive dedicado ao NeonOS.', ok: 'Criar partição', danger: true })) return;
        const r = await rootCall('/api/persist/setup');
        if (!r || !r.job) return;
        const j = await watchJob(r.job, $('.log', ps));
        if (j.code === 0) toast('Persistência pronta', 'Reinicie para ativar', 'ok');
      };
    }
  };
  const show = k => { if (!R[k]) k = 'look'; $$('nav button', body).forEach(b => b.classList.toggle('on', b.dataset.tab === k)); R[k](); };
  $$('nav button', body).forEach(b => b.onclick = () => show(b.dataset.tab));
  ctx.onArg = t => t && show(t);
  ctx.onClose(bus.on('settings', () => { const on = $('nav button.on', body); if (on && on.dataset.tab === 'look') R.look(); }));
  show(tab || 'look');
}};

/* ------------------------------------------------------------ Instalador */
APPS.installer = { name: 'Instalar', icon: '⤓', w: 560, h: 420, single: true, visible: () => SYS.live || SYS.dev, mount(body) {
  body.innerHTML = `<div class="inst-app"><h2>INSTALAR O NEONOS</h2>
    <p>Copia o sistema do pendrive para o disco do computador, para ele iniciar sem o pendrive.</p>
    <ol><li>Faça backup: o instalador pode apagar o disco escolhido.</li><li>Ligue o computador na tomada.</li><li>Siga as etapas: idioma, teclado, disco e usuário.</li><li>Ao terminar, reinicie e remova o pendrive.</li></ol>
    <p class="c-d">No sistema instalado, a senha é a que você escolher no instalador.</p>
    <button class="btn hot go">Iniciar instalador</button></div>`;
  $('.go', body).onclick = async () => {
    const r = await api('/api/installer', {}).catch(() => ({}));
    r.ok ? toast('Abrindo instalador', 'Ele aparece em uma janela nova') : toast('Instalador indisponível', r.error || '', 'err');
  };
}};

/* ------------------------------------------------------------ ASCII Lab */
APPS.lab = { name: 'ASCII Lab', icon: '░', w: 760, h: 480, mount(body, ctx) {
  const keys = Object.keys(Ascii.FX);
  body.innerHTML = `<div class="lab"><div class="lab-bar">${keys.map(k => `<button class="mini" data-fx="${k}">${esc(Ascii.FX[k].name)}</button>`).join('')}
    <button class="mini sv" title="Usar como protetor de tela">◈ protetor</button><span class="c-d">←/→ troca · tela cheia: □</span></div><canvas></canvas></div>`;
  let cur = keys[0];
  const loop = asciiLoop($('canvas', body), cur, { size: 13 });
  const set = k => { cur = k; loop.set(k); $$('[data-fx]', body).forEach(b => b.classList.toggle('on', b.dataset.fx === k)); ctx.setTitle('ASCII Lab · ' + Ascii.FX[k].name); };
  $$('[data-fx]', body).forEach(b => b.onclick = () => set(b.dataset.fx));
  $('.sv', body).onclick = () => { if (cur === 'radar') return toast('O radar não pode ser protetor', 'Escolha outro efeito', 'err'); SETTINGS.saverFx = cur; saveSettings(); toast('Protetor de tela', Ascii.FX[cur].name, 'ok'); };
  body.tabIndex = 0;
  body.addEventListener('keydown', e => {
    const i = keys.indexOf(cur);
    if (e.key === 'ArrowRight') set(keys[(i + 1) % keys.length]);
    if (e.key === 'ArrowLeft') set(keys[(i - 1 + keys.length) % keys.length]);
  });
  ctx.onClose(() => loop.stop());
  set(cur); setTimeout(() => body.focus(), 50);
}};

start();
