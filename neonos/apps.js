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
const ARCH_RE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|tzst|7z|rar|gz|bz2|xz|zst|cab)$/i;
const shq = p => "'" + String(p).replace(/'/g, "'\\''") + "'";
function openInternal(path) {
  if (MEDIA_RE.test(path)) openApp('player', path);
  else if (IMG_RE.test(path)) openApp('viewer', path);
  else openApp('editor', path);
}
/* abre um arquivo com o app certo: os do NeonOS, um app instalado ou pergunta qual usar */
async function openPath(path) {
  if (/\.flatpak(ref)?$/i.test(path)) return openApp('terminal', { cmd: 'neon-flatpak ' + shq(path) });
  if (/\.deb$/i.test(path)) return installDeb(path);
  if (/\.appimage$/i.test(path)) {
    if (!await ask({ title: 'Executar programa?', text: `"${baseP(path)}" é um programa (AppImage). Só execute se confiar em quem fez.`, ok: 'Executar' })) return;
    const r = await api('/api/fs/run', { path });
    return r.error ? toast('Não abriu', r.error, 'err') : toast('Abrindo', baseP(path));
  }
  if (!SYS.linux) return openInternal(path);
  const r = await api('/api/open', { path }).catch(() => ({ error: 'sem resposta do sistema' }));
  if (r.internal) openApp(r.internal, path);
  else if (r.terminal) openApp('terminal', { cmd: r.terminal });
  else if (r.choose) openWith(path);
  else if (r.ok) toast('Abrindo', r.name);
  else toast('Não foi possível abrir', r.error || '', 'err');
}
async function installDeb(path) {
  if (!await ask({ title: 'Instalar pacote?', text: `Instalar "${baseP(path)}" no sistema? Pacotes de fora do Debian podem não ser seguros — só instale de quem você confia.`, ok: 'Instalar' })) return;
  const r = await rootCall('/api/fs/install-deb', { path });
  if (r && r.job) { toast('Instalando', baseP(path)); const j = await watchJob(r.job); if (j.code === 0) loadApps(true).then(renderAllApps); }
}
function dialog(html, cls = '') {
  const m = el('div', 'modal');
  m.innerHTML = `<div class="box ${cls}">${html}</div>`;
  document.body.appendChild(m); Layer.up(true);
  const close = () => { m.remove(); Layer.down(); };
  m.addEventListener('pointerdown', e => { if (e.target === m) close(); });
  m.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') close(); });
  return { m, close };
}
async function openWith(path) {
  const info = await api('/api/open/info?' + qs({ path })).catch(() => null);
  if (!info || info.error) return openInternal(path);
  const ext = (baseP(path).match(/\.[^.]+$/) || [''])[0];
  const { m, close } = dialog(`<h3>Abrir com</h3><p class="c-d">${esc(baseP(path))} <small>· ${esc(info.mime)}</small></p><div class="ow-list"></div>
    <label class="row"><input type="checkbox" class="rm"> Sempre usar para arquivos ${esc(ext || 'deste tipo')}</label>
    <div class="btns"><button class="btn st">Procurar na Loja</button><button class="btn c">Cancelar</button></div>`, 'ow');
  const list = $('.ow-list', m), opts = [...info.apps];
  if (!opts.some(a => a.neon === 'editor')) opts.push({ id: 'neonos-editor.desktop', name: 'Editor de texto (NeonOS)', neon: 'editor' });
  opts.forEach(a => {
    const ic = a.neon ? esc((APPS[a.neon] || {}).icon || '◇') : a.icon ? `<img src="/api/icon?${qs({ app: a.id })}" alt="">` : '◇';
    const b = el('button', 'sm-row' + (info.default && info.default.id === a.id ? ' sel' : ''), `<span class="sm-ni">${ic}</span><span>${esc(a.name)}${info.default && info.default.id === a.id ? '<small>padrão atual</small>' : ''}</span>`);
    b.onclick = async () => {
      const remember = $('.rm', m).checked; close();
      if (a.neon && !remember) return openApp(a.neon, path);
      const r = await api('/api/open', { path, app: a.id, remember });
      if (r.internal) openApp(r.internal, path); else if (r.terminal) openApp('terminal', { cmd: r.terminal });
      else if (r.ok) toast('Abrindo', r.name); else toast('Não foi possível abrir', r.error || '', 'err');
    };
    list.appendChild(b);
  });
  $('.c', m).onclick = close;
  $('.st', m).onclick = () => { close(); openApp('store', ext.replace('.', '')); };
}
async function watchJob(id, pre, onProgress) {
  if (pre) { pre.classList.add('on'); pre.textContent = ''; }
  for (;;) {
    const j = await api('/api/jobs?' + qs({ id })).catch(() => ({ error: 'sem resposta' }));
    if (j.error) return j;
    if (pre) { pre.textContent = j.log || '…'; pre.scrollTop = pre.scrollHeight; }
    if (onProgress) onProgress(j.progress ?? null, j);
    if (j.done) return j;
    await sleep(onProgress ? 400 : 1000);
  }
}
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('Copiado', t.length > 60 ? t.slice(0, 60) + '…' : t, 'ok'); } catch { toast('Não foi possível copiar', '', 'err'); } }

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
const FCLIP = { mode: null, items: [] };                // área de transferência de arquivos (vale entre janelas)
const fileGlyph = it => it.dir ? '▰' : IMG_RE.test(it.name) ? '▣' : MEDIA_RE.test(it.name) ? '♫' : ARCH_RE.test(it.name) ? '▤'
  : /\.(deb|appimage|flatpak|flatpakref|sh|exe)$/i.test(it.name) ? '⬢' : /\.pdf$/i.test(it.name) ? '▥' : /\.(odt|docx?|ods|xlsx?|odp|pptx?)$/i.test(it.name) ? '▦' : '≡';
const fmtDate = t => new Date(t * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
APPS.files = { name: 'Arquivos', icon: '▤', kw: 'pastas explorer documentos downloads pendrive gerenciador', w: 840, h: 520, mount(body, ctx, start) {
  const H = SYS.home, TRASHP = H + '/.local/share/Trash/files';
  let cwd = start || H, hidden = false, view = SETTINGS.fmView || 'grid', sort = SETTINGS.fmSort || 'name';
  let items = [], sel = new Set(), anchor = null, hist = [], fwd = [], searchRes = null, filter = '', busy = 0, prog = null, first = true;
  const places = [['⌂', 'Início', H], ['▰', 'Documentos', H + '/Documentos'], ['⇣', 'Downloads', H + '/Downloads'], ['♫', 'Música', H + '/Música'],
    ['▣', 'Imagens', H + '/Imagens'], ['▶', 'Vídeos', H + '/Vídeos'], ['✕', 'Lixeira', TRASHP], ['/', 'Sistema (raiz)', '/']];
  body.innerHTML = `<div class="fm"><div class="fm-bar">
      <button class="mini bk" title="Voltar (Alt+←)">←</button><button class="mini fw" title="Avançar (Alt+→)">→</button><button class="mini up" title="Pasta acima (Backspace)">↑</button>
      <input class="field fm-loc" spellcheck="false" title="Caminho (Ctrl+L)"><input class="field fm-find" placeholder="⌕ filtrar · Enter busca nas subpastas" spellcheck="false">
      <select class="field so" title="Ordenar por"><option value="name">nome</option><option value="date">data</option><option value="size">tamanho</option><option value="type">tipo</option></select>
      <button class="mini vw" title="Grade ou lista"></button><button class="mini hd" title="Mostrar ocultos (Ctrl+H)">.*</button>
      <button class="mini nd" title="Nova pasta (Ctrl+Shift+N)">+▰</button><button class="mini tm" title="Terminal aqui">❯_</button></div>
    <div class="fm-side"><h6>LOCAIS</h6>${places.map(([g, l, p]) => `<button data-p="${esc(p)}"><i>${g}</i> ${l}</button>`).join('')}<h6>DISPOSITIVOS</h6><div class="fm-drv"></div></div>
    <div class="fm-main" tabindex="0"><div class="fm-grid"></div></div><div class="fm-status"><span class="sl"></span><span class="sr"></span></div></div>`;
  const grid = $('.fm-grid', body), main = $('.fm-main', body), loc = $('.fm-loc', body), find = $('.fm-find', body);
  const pathOf = it => it.path || joinP(cwd, it.name);
  const inTrash = () => cwd === TRASHP;
  $('.so', body).value = sort;

  async function load(path, push = true) {
    const r = await api('/api/fs/list?' + qs({ path, hidden: hidden ? 1 : '' })).catch(e => ({ error: e.message }));
    if (r.error) { toast('Não foi possível abrir', r.error, 'err'); if (first) { first = false; load(H, false); } return false; }
    if (push && r.path !== cwd) { hist.push(cwd); fwd = []; }
    const fresh = r.path !== cwd || first;
    first = false; cwd = r.path; items = r.items; searchRes = null; filter = ''; find.value = '';
    if (fresh) { sel.clear(); anchor = null; }
    draw(fresh); return true;
  }
  function shown() {
    let list = searchRes || items;
    if (filter) list = list.filter(i => norm(i.name).includes(norm(filter)));
    const ext = n => (n.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase();
    const cmp = { name: (a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }), size: (a, b) => b.size - a.size,
      date: (a, b) => b.mtime - a.mtime, type: (a, b) => ext(a.name).localeCompare(ext(b.name)) || a.name.localeCompare(b.name, 'pt-BR') }[sort];
    return [...list].sort((a, b) => (b.dir - a.dir) || cmp(a, b));
  }
  function draw(fresh) {
    const list = shown();
    grid.className = 'fm-grid ' + view; grid.innerHTML = '';
    $('.vw', body).textContent = view === 'grid' ? '☰' : '▦';
    loc.value = searchRes ? `${cwd}  ⌕ ${find.value}` : cwd;
    ctx.setTitle('Arquivos · ' + (searchRes ? 'busca' : inTrash() ? 'Lixeira' : baseP(cwd)));
    $$('.fm-side [data-p]', body).forEach(b => b.classList.toggle('on', b.dataset.p === cwd));
    if (view === 'list' && list.length) grid.appendChild(el('div', 'fm-head', '<span></span><span>NOME</span><span>TAMANHO</span><span>MODIFICADO</span>'));
    if (!list.length) grid.innerHTML = ghostEmpty(searchRes ? 'nada encontrado nas subpastas' : filter ? 'nada com esse nome aqui' : inTrash() ? 'lixeira vazia' : 'pasta vazia — nada por aqui além de fantasmas');
    let n = 0;
    list.forEach((it, idx) => {
      const p = pathOf(it), thumb = !it.dir && IMG_RE.test(it.name) && it.size < 15e6;
      const d = el('div', `fm-item ${it.dir ? 'dir' : 'file'}${MEDIA_RE.test(it.name) ? ' media' : ''}${sel.has(p) ? ' sel' : ''}${FCLIP.mode === 'move' && FCLIP.items.includes(p) ? ' cut' : ''}`,
        `<div class="g">${thumb ? `<img loading="lazy" src="${rawURL(p)}" alt="">` : fileGlyph(it)}</div><span class="nm"></span>`
        + (view === 'list' ? `<span class="sz">${it.dir ? '—' : fmtSize(it.size)}</span><span class="dt">${it.mtime ? fmtDate(it.mtime) : ''}</span>` : '')
        + (searchRes ? `<small class="wh">${esc(it.where === '.' ? '' : it.where)}</small>` : ''));
      d.dataset.p = p; d.draggable = !inTrash();
      const nm = $('.nm', d);
      if (fresh && view === 'grid' && n++ < 40 && Ascii.full()) { nm.textContent = it.name.replace(/\S/g, '░'); setTimeout(() => Ascii.scramble(nm, it.name, 300), n * 14); }
      else nm.textContent = it.name;
      d.title = it.dir ? it.name : `${it.name} · ${fmtSize(it.size)}${it.mtime ? ' · ' + fmtDate(it.mtime) : ''}`;
      d.onclick = e => pick(e, p, idx, list);
      d.ondblclick = () => openItem(it, p);
      d.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); itemMenu(e, it, p); };
      d.ondragstart = e => { if (!sel.has(p)) { sel.clear(); sel.add(p); mark(); } e.dataTransfer.setData('application/x-neon-files', JSON.stringify([...sel])); e.dataTransfer.effectAllowed = 'copyMove'; };
      if (it.dir) dropZone(d, () => p);
      grid.appendChild(d);
    });
    status();
  }
  function pick(e, p, idx, list) {
    if (e.ctrlKey || e.metaKey) { sel.has(p) ? sel.delete(p) : sel.add(p); anchor = idx; }
    else if (e.shiftKey && anchor != null) { sel.clear(); for (let i = Math.min(anchor, idx); i <= Math.max(anchor, idx); i++) sel.add(pathOf(list[i])); }
    else { sel.clear(); sel.add(p); anchor = idx; }
    mark(); Sfx.click();
  }
  function mark() { $$('.fm-item', grid).forEach(x => x.classList.toggle('sel', sel.has(x.dataset.p))); status(); }
  function status() {
    const list = shown(), chosen = list.filter(i => sel.has(pathOf(i)));
    const size = chosen.reduce((t, i) => t + (i.dir ? 0 : i.size), 0);
    $('.sl', body).textContent = `${list.length} ite${list.length === 1 ? 'm' : 'ns'}` + (chosen.length ? ` · ${chosen.length} selecionado${chosen.length > 1 ? 's' : ''}${size ? ' · ' + fmtSize(size) : ''}` : '');
    $('.sr', body).textContent = busy ? `${prog != null ? `[${'█'.repeat(Math.round(prog * 16)).padEnd(16, '░')}] ${Math.round(prog * 100)}%` : Ascii.loading('trabalhando')}`
      : FCLIP.items.length ? `${FCLIP.mode === 'move' ? 'recortado' : 'copiado'}: ${FCLIP.items.length} · Ctrl+V cola` : '';
  }
  function dropZone(node, dest) {
    node.addEventListener('dragover', e => { if (!e.dataTransfer.types.includes('application/x-neon-files')) return; e.preventDefault(); node.classList.add('drop'); e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'; });
    node.addEventListener('dragleave', () => node.classList.remove('drop'));
    node.addEventListener('drop', e => {
      node.classList.remove('drop'); const items = JSON.parse(e.dataTransfer.getData('application/x-neon-files') || '[]'), to = dest();
      if (!items.length) return; e.preventDefault(); e.stopPropagation();
      if (to === TRASHP) return del(items);
      if (items.includes(to)) return;
      job(api('/api/fs/paste', { items, dest: to, mode: e.ctrlKey ? 'copy' : 'move' }));
    });
  }
  async function job(req) {
    const r = await req;
    if (!r || r.error) { if (r && r.error) toast('Não foi possível', r.error, 'err'); return null; }
    if (!r.job) return r;
    busy++; status();
    const j = await watchJob(r.job, null, pr => { prog = pr; status(); });
    busy--; prog = null; status(); load(cwd, false);
    return j;
  }
  function openItem(it, p) {
    if (it.dir) return load(p);
    if (inTrash()) return toast('Está na lixeira', 'Restaure o arquivo para abrir', 'info');
    openPath(p);
  }
  const selected = () => [...sel];
  const clip = mode => { if (!sel.size) return; FCLIP.mode = mode; FCLIP.items = selected(); toast(mode === 'move' ? 'Recortado' : 'Copiado', `${FCLIP.items.length} item(ns) — Ctrl+V para colar`); bus.emit('fclip'); };
  async function paste(dest) {
    if (!FCLIP.items.length) return;
    const mode = FCLIP.mode, items = FCLIP.items;
    if (mode === 'move') { FCLIP.items = []; FCLIP.mode = null; bus.emit('fclip'); }
    await job(api('/api/fs/paste', { items, dest, mode }));
  }
  async function del(paths, forever) {
    if (!paths.length) return;
    if (forever || inTrash()) {
      if (!await ask({ title: 'Apagar de vez?', text: `${paths.length} item(ns) serão apagados permanentemente. Não dá para desfazer.`, ok: 'Apagar', danger: true })) return;
      const r = await api(inTrash() ? '/api/fs/trash' : '/api/fs/delete', { paths });
      if (r.error) toast('Erro', r.error, 'err');
    } else {
      const r = await api('/api/fs/trash', { paths });
      if (r.error) toast('Não foi para a lixeira', r.error, 'err'); else toast('Movido para a lixeira', `${paths.length} item(ns) · dá para restaurar`, 'info');
    }
    sel.clear(); bus.emit('fs');
  }
  async function restore(paths) { const r = await api('/api/fs/restore', { names: paths.map(baseP) }); r.error ? toast('Erro', r.error, 'err') : toast('Restaurado', `${r.restored} item(ns) voltaram ao lugar`, 'ok'); bus.emit('fs'); }
  async function emptyTrash() { if (await ask({ title: 'Esvaziar a lixeira?', text: 'Tudo na lixeira será apagado de vez.', ok: 'Esvaziar', danger: true })) { await api('/api/fs/empty-trash', {}); bus.emit('fs'); } }
  async function compress(paths) {
    const n = await ask({ title: 'Compactar em .zip', input: 'text', value: paths.length === 1 ? baseP(paths[0]).replace(/\.[^.]+$/, '') : 'arquivos', ok: 'Compactar' });
    if (n) job(api('/api/fs/compress', { paths, name: n }));
  }
  async function rename(p) {
    const old = baseP(p), n = await ask({ title: 'Renomear', input: 'text', value: old, ok: 'Renomear' });
    if (n && n !== old) { const x = await api('/api/fs/rename', { path: p, name: n }); x.error ? toast('Erro', x.error, 'err') : bus.emit('fs'); }
  }
  async function create(kind) {
    const n = await ask({ title: kind === 'dir' ? 'Nova pasta' : 'Novo arquivo', input: 'text', value: kind === 'dir' ? 'nova pasta' : 'novo.txt', ok: 'Criar' });
    if (!n) return;
    const x = await api(kind === 'dir' ? '/api/fs/mkdir' : '/api/fs/touch', { path: joinP(cwd, n) });
    x.error ? toast('Erro', x.error, 'err') : bus.emit('fs');
  }
  async function props(p) {
    const i = await api('/api/fs/info?' + qs({ path: p }));
    if (i.error) return toast('Erro', i.error, 'err');
    const { m, close } = dialog(`<h3>Propriedades</h3><div class="kv"><span>Nome</span><span>${esc(i.name)}</span><span>Local</span><span>${esc(parentP(i.path))}</span>
      <span>Tipo</span><span>${i.dir ? 'pasta' : esc(i.mime)}</span><span>Tamanho</span><span>${fmtSize(i.size)}${i.partial ? '+ (pasta muito grande)' : ''}${i.dir ? ` · ${i.count} itens` : ''}</span>
      <span>Modificado</span><span>${fmtDate(i.mtime)}</span><span>Permissões</span><span>${esc(i.mode)} · dono ${esc(i.owner)}</span>
      ${i.link ? `<span>Atalho para</span><span>${esc(i.link)}</span>` : ''}${i.free != null ? `<span>Espaço livre</span><span>${fmtSize(i.free)} de ${fmtSize(i.total)}</span>` : ''}</div>
      <div class="btns"><button class="btn cp">Copiar caminho</button><button class="btn o">OK</button></div>`);
    $('.o', m).onclick = close; $('.cp', m).onclick = () => copyText(i.path);
  }
  function itemMenu(e, it, p) {
    if (!sel.has(p)) { sel.clear(); sel.add(p); mark(); }
    const paths = selected(), one = paths.length === 1, m = [];
    if (inTrash()) {
      return ctxMenu(e.clientX, e.clientY, [{ label: 'Restaurar', fn: () => restore(paths) }, { label: 'Apagar definitivamente', danger: true, fn: () => del(paths, true) }]);
    }
    if (one) {
      m.push({ label: 'Abrir', fn: () => openItem(it, p) });
      if (!it.dir) m.push({ label: 'Abrir com…', fn: () => openWith(p) });
      if (it.dir) m.push({ label: 'Abrir em nova janela', fn: () => openApp('files', p) }, { label: 'Abrir terminal aqui', fn: () => openApp('terminal', { cwd: p }) });
      if (ARCH_RE.test(it.name)) m.push({ label: 'Extrair aqui', fn: () => job(api('/api/fs/extract', { path: p })) });
      if (/\.deb$/i.test(it.name)) m.push({ label: 'Instalar pacote', fn: () => installDeb(p) });
      if (/\.(appimage|sh)$/i.test(it.name)) m.push({ label: 'Executar', fn: async () => { const r = await api('/api/fs/run', { path: p }); r.terminal ? openApp('terminal', { cmd: r.terminal }) : r.error ? toast('Erro', r.error, 'err') : toast('Abrindo', it.name); } });
      if (!it.dir && /\.(txt|md|json|sh|py|js|css|html|conf|ini|log|csv|xml|yml|yaml|toml|desktop)$/i.test(it.name)) m.push({ label: 'Editar no NeonOS', fn: () => openApp('editor', p) });
    }
    m.push({ label: 'Recortar (Ctrl+X)', fn: () => clip('move') }, { label: 'Copiar (Ctrl+C)', fn: () => clip('copy') });
    if (one && it.dir && FCLIP.items.length) m.push({ label: `Colar dentro (${FCLIP.items.length})`, fn: () => paste(p) });
    m.push({ label: 'Compactar em .zip…', fn: () => compress(paths) });
    if (one) m.push({ label: 'Renomear… (F2)', fn: () => rename(p) });
    m.push({ label: 'Copiar caminho', fn: () => copyText(paths.join('\n')) });
    if (one) m.push({ label: 'Propriedades', fn: () => props(p) });
    m.push({ label: 'Mover para a lixeira (Del)', danger: true, fn: () => del(paths) });
    ctxMenu(e.clientX, e.clientY, m);
  }
  function go(fn) { return () => { fn(); main.focus(); }; }
  const back = () => { if (hist.length) { fwd.push(cwd); load(hist.pop(), false); } };
  const forward = () => { if (fwd.length) { hist.push(cwd); load(fwd.pop(), false); } };
  const upDir = () => load(parentP(cwd));
  const toggleHidden = () => { hidden = !hidden; $('.hd', body).classList.toggle('c-a', hidden); load(cwd, false); };
  const selectAll = () => { shown().forEach(i => sel.add(pathOf(i))); mark(); };
  $('.bk', body).onclick = go(back); $('.fw', body).onclick = go(forward); $('.up', body).onclick = go(upDir);
  $('.nd', body).onclick = () => create('dir'); $('.hd', body).onclick = go(toggleHidden);
  $('.tm', body).onclick = () => openApp('terminal', { cwd });
  $('.vw', body).onclick = go(() => { view = view === 'grid' ? 'list' : 'grid'; SETTINGS.fmView = view; saveSettings(); draw(); });
  $('.so', body).onchange = e => { sort = e.target.value; SETTINGS.fmSort = sort; saveSettings(); draw(); main.focus(); };
  $$('.fm-side [data-p]', body).forEach(b => { b.onclick = () => load(b.dataset.p); dropZone(b, () => b.dataset.p); });
  loc.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { load(loc.value.replace(/\s+⌕.*$/, '').trim() || H); main.focus(); } if (e.key === 'Escape') { loc.value = cwd; main.focus(); } };
  loc.onfocus = () => { loc.value = cwd; loc.select(); };
  find.oninput = throttle(() => { filter = find.value; searchRes = null; draw(); }, 120);
  find.onkeydown = async e => {
    e.stopPropagation();
    if (e.key === 'Enter' && find.value.trim()) {
      $('.sr', body).textContent = Ascii.loading('vasculhando subpastas');
      const r = await api('/api/fs/search?' + qs({ path: cwd, q: find.value.trim(), hidden: hidden ? 1 : '' })).catch(() => ({ items: [] }));
      searchRes = r.items || []; filter = ''; sel.clear(); draw(true);
      if (r.truncated) toast('Busca parcial', 'Muitos arquivos — mostrando os primeiros encontrados');
    }
    if (e.key === 'Escape') { find.value = ''; filter = ''; searchRes = null; draw(); main.focus(); }
  };
  grid.onclick = e => { if (!e.target.closest('.fm-item')) { sel.clear(); mark(); } };
  dropZone(main, () => cwd);
  main.addEventListener('pointerdown', () => main.focus());
  grid.oncontextmenu = e => {
    if (e.target.closest('.fm-item')) return;
    e.preventDefault(); sel.clear(); mark();
    if (inTrash()) return ctxMenu(e.clientX, e.clientY, [{ label: 'Esvaziar lixeira', danger: true, fn: emptyTrash }]);
    ctxMenu(e.clientX, e.clientY, [
      { label: 'Nova pasta…', fn: () => create('dir') }, { label: 'Novo arquivo de texto…', fn: () => create('file') },
      ...(FCLIP.items.length ? [{ label: `Colar ${FCLIP.items.length} item(ns) (Ctrl+V)`, fn: () => paste(cwd) }] : []),
      { label: 'Selecionar tudo (Ctrl+A)', fn: selectAll }, { label: 'Abrir terminal aqui', fn: () => openApp('terminal', { cwd }) },
      { label: hidden ? 'Esconder arquivos ocultos' : 'Mostrar arquivos ocultos', fn: toggleHidden }, { label: 'Propriedades da pasta', fn: () => props(cwd) }]);
  };
  main.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase(), c = e.ctrlKey || e.metaKey, one = sel.size === 1 ? [...sel][0] : null;
    if (c && k === 'c') clip('copy'); else if (c && k === 'x') clip('move'); else if (c && k === 'v') paste(cwd);
    else if (c && k === 'a') selectAll(); else if (c && k === 'h') toggleHidden(); else if (c && k === 'l') loc.focus(); else if (c && k === 'f') find.focus();
    else if (c && e.shiftKey && k === 'n') create('dir');
    else if (e.key === 'Delete') del(selected(), e.shiftKey);
    else if (e.key === 'F2' && one) rename(one);
    else if (e.key === 'F5') load(cwd, false);
    else if (e.key === 'Enter' && one) { const it = shown().find(i => pathOf(i) === one); if (it) openItem(it, one); }
    else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) upDir();
    else if (e.altKey && e.key === 'ArrowLeft') back(); else if (e.altKey && e.key === 'ArrowRight') forward();
    else if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      const list = shown(); if (!list.length) return;
      const cols = view === 'grid' ? Math.max(1, Math.round(grid.clientWidth / 100)) : 1;
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      const i = Math.max(0, Math.min(list.length - 1, (anchor ?? -step) + step));
      sel.clear(); sel.add(pathOf(list[i])); anchor = i; mark();
      const node = grid.querySelector(`[data-p="${CSS.escape(pathOf(list[i]))}"]`); if (node) node.scrollIntoView({ block: 'nearest' });
    }
    else if (e.key === 'Escape') { sel.clear(); mark(); }
    else return;
    e.preventDefault(); e.stopPropagation();
  });
  function drawDrives() {
    const box = $('.fm-drv', body);
    box.innerHTML = DRIVES.length ? '' : '<small class="c-d">nenhum</small>';
    DRIVES.forEach(d => {
      const b = el('button', d.mount && cwd.startsWith(d.mount) ? 'on' : '', `<i>${d.removable ? '⏏' : '▣'}</i> ${esc(d.label || d.model || fmtSize(d.size))}`);
      b.title = `${d.dev} · ${fmtSize(d.size)} · ${d.fstype}${d.mount ? '' : ' · clique para abrir'}`;
      b.onclick = async () => {
        let path = d.mount;
        if (!path) { $('.sr', body).textContent = Ascii.loading('montando'); const r = await api('/api/drives/mount', { dev: d.dev }); if (r.error) return toast('Não foi possível abrir', r.error, 'err'); path = r.path; }
        if (path) load(path);
      };
      if (d.mount) b.oncontextmenu = e => { e.preventDefault(); ctxMenu(e.clientX, e.clientY, [{ label: d.removable ? 'Remover com segurança' : 'Desmontar', fn: () => driveEject(d) }]); };
      box.appendChild(b);
    });
  }
  ctx.onClose(bus.on('fs', () => load(cwd, false)));
  ctx.onClose(bus.on('fclip', () => { mark(); draw(); }));
  ctx.onClose(bus.on('drives', drawDrives));
  ctx.onArg = p => load(p);
  drawDrives(); refreshDrives();
  load(cwd, false).then(() => main.focus());
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

/* ------------------------------------------------------------ Loja de apps (Flathub + Debian) */
const FLATHUB = [
  ['com.discordapp.Discord', 'Discord', 'Chat de voz e texto dos jogos'], ['com.spotify.Client', 'Spotify', 'Música por streaming'],
  ['com.obsproject.Studio', 'OBS Studio', 'Gravar a tela e fazer lives'], ['com.heroicgameslauncher.hgl', 'Heroic Games', 'Jogos da Epic Games, GOG e Amazon'],
  ['net.lutris.Lutris', 'Lutris', 'Central de jogos (inclui jogos de Windows)'], ['com.usebottles.bottles', 'Bottles', 'Rodar programas de Windows'],
  ['net.davidotek.pupgui2', 'ProtonUp-Qt', 'Versões extras do Proton para a Steam'], ['org.prismlauncher.PrismLauncher', 'Prism Launcher', 'Minecraft Java'],
  ['com.google.Chrome', 'Google Chrome', 'Navegador do Google'], ['com.brave.Browser', 'Brave', 'Navegador com bloqueio de anúncios'],
  ['com.visualstudio.code', 'VS Code', 'Editor de código'], ['org.gimp.GIMP', 'GIMP', 'Editor de imagens'],
  ['org.kde.krita', 'Krita', 'Pintura digital'], ['org.blender.Blender', 'Blender', 'Modelagem e animação 3D'],
  ['org.kde.kdenlive', 'Kdenlive', 'Edição de vídeo'], ['org.audacityteam.Audacity', 'Audacity', 'Edição de áudio'],
  ['org.inkscape.Inkscape', 'Inkscape', 'Desenho vetorial'], ['org.telegram.desktop', 'Telegram', 'Mensagens'],
  ['org.qbittorrent.qBittorrent', 'qBittorrent', 'Torrents'], ['md.obsidian.Obsidian', 'Obsidian', 'Anotações'],
  ['us.zoom.Zoom', 'Zoom', 'Reuniões por vídeo'], ['org.mozilla.Thunderbird', 'Thunderbird', 'E-mail'],
  ['io.missioncenter.MissionCenter', 'Mission Center', 'Monitor de sistema detalhado'], ['com.github.tchx84.Flatseal', 'Flatseal', 'Permissões dos apps Flatpak'],
];
const DEBFEAT = [['wine', 'Wine', 'Rodar programas .exe do Windows'], ['gimp', 'GIMP', 'Editor de imagens'], ['inkscape', 'Inkscape', 'Desenho vetorial'],
  ['krita', 'Krita', 'Pintura digital'], ['obs-studio', 'OBS Studio', 'Gravar a tela e fazer lives'], ['kdenlive', 'Kdenlive', 'Edição de vídeo'],
  ['audacity', 'Audacity', 'Editar áudio'], ['thunderbird', 'Thunderbird', 'E-mail'], ['transmission-gtk', 'Transmission', 'Torrents'],
  ['btop', 'btop', 'Monitor de sistema no terminal'], ['neovim', 'Neovim', 'Editor de código no terminal'], ['cmatrix', 'cmatrix', 'Chuva de código no terminal']];
APPS.store = { name: 'Loja', icon: '⬡', kw: 'instalar apps programas flathub flatpak baixar', w: 880, h: 580, single: true, mount(body, ctx, start) {
  body.innerHTML = `<div class="st"><div class="st-top"><input class="field" placeholder="buscar apps (Flathub e Debian)…" spellcheck="false"><button class="btn bs">Buscar</button></div>
    <div class="st-tabs"><button data-t="feat">Destaques</button><button data-t="inst">Instalados</button><button data-t="deb">Pacotes do Debian</button></div>
    <div class="st-scroll"></div><pre class="log"></pre></div>`;
  const scroll = $('.st-scroll', body), log = $('.log', body), inp = $('input', body);
  let busy = false, tab = 'feat';
  const section = (title, cls = '') => { const h = el('div', 'st-head', esc(title)), l = el('div', 'st-list ' + cls); scroll.append(h, l); return l; };
  const card = (kind, id, title, desc, installed) => {
    const ic = kind === 'fp' ? `<img src="/api/icon?${qs({ flatpak: id })}" alt="">` : '<i>⬢</i>';
    const c = el('div', 'card' + (installed ? ' inst' : ''), `<div class="card-h"><span class="ci">${ic}</span><div><b>${esc(title)}</b><small>${esc(desc || '')}</small></div></div>
      <small class="src">${kind === 'fp' ? 'Flathub' : 'Debian'} · ${esc(id)}</small>
      <div class="card-b"><button class="btn ${installed ? 'hot' : ''} ac">${installed ? 'Remover' : 'Instalar'}</button>${installed && kind === 'fp' ? '<button class="btn op">Abrir</button>' : ''}</div>`);
    $('.ac', c).onclick = () => act(kind, installed ? 'remove' : 'install', id, title, c);
    if ($('.op', c)) $('.op', c).onclick = async () => { const a = (await loadApps(true)).find(x => x.id === id + '.desktop'); a ? launchNative(a) : toast('Abra pelo menu', 'O app aparece no menu iniciar'); };
    c.onmouseenter = () => Ascii.scramble($('b', c), title, 250);
    return c;
  };
  async function act(kind, action, id, title, cardEl) {
    if (busy) return toast('Aguarde', 'Já existe uma instalação em andamento');
    if (action === 'remove' && !await ask({ title: `Remover ${title}?`, ok: 'Remover', danger: true })) return;
    busy = true; $$('.ac', body).forEach(b => b.disabled = true);
    const r = kind === 'fp' ? (action === 'install' ? await api('/api/flatpak/install', { id, name: title }) : await rootCall('/api/flatpak/remove', { id, name: title }))
      : await rootCall('/api/store/' + action, { pkg: id });
    if (r && r.error && kind === 'fp') toast('Erro', r.error, 'err');
    if (r && r.job) {
      toast(action === 'install' ? 'Instalando' : 'Removendo', `${title}${kind === 'fp' && action === 'install' ? ' — apps do Flathub podem baixar bastante na primeira vez' : ''}`);
      const b = cardEl && $('.card-b', cardEl); if (b) b.innerHTML = `<div class="c-a">${Ascii.bar(14)}</div>`;
      const j = await watchJob(r.job, log);
      if (j.code === 0) { loadApps(true).then(() => { buildDesktop(); renderAllApps(); }); if (action === 'install') toast(`${title} instalado`, 'Está no menu iniciar (tecla Windows)', 'ok'); }
    }
    busy = false; $$('.ac', body).forEach(b => b.disabled = false);
    refresh();
  }
  async function feat() {
    scroll.innerHTML = '';
    const fl = section('// APPS POPULARES · FLATHUB'), dl = section('// DO DEBIAN');
    const [fs, ds] = await Promise.all([api('/api/flatpak/check?' + qs({ ids: FLATHUB.map(f => f[0]).join(',') })).catch(() => ({})),
      api('/api/store/status?' + qs({ pkgs: DEBFEAT.map(f => f[0]).join(',') })).catch(() => ({}))]);
    FLATHUB.forEach(([i, t, d]) => fl.appendChild(card('fp', i, t, d, (fs.status || {})[i])));
    DEBFEAT.forEach(([i, t, d]) => dl.appendChild(card('deb', i, t, d, (ds.status || {})[i])));
  }
  async function search() {
    const q = inp.value.trim(); if (!q) return show('feat');
    $$('.st-tabs button', body).forEach(b => b.classList.remove('on')); tab = 'search';
    scroll.innerHTML = '';
    const fl = section(`// FLATHUB · "${q}"`), dl = section(`// DEBIAN · "${q}"`);
    fl.innerHTML = dl.innerHTML = `<div class="c-d">${Ascii.loading('consultando')}</div>`;
    api('/api/flatpak/search?' + qs({ q })).catch(() => ({ items: [] })).then(r => {
      fl.innerHTML = r.available === false ? '<div class="c-d">Flatpak indisponível neste sistema.</div>' : r.error ? `<div class="c-d">${esc(r.error)}</div>` : r.items.length ? '' : '<div class="c-d">nada encontrado no Flathub</div>';
      (r.items || []).forEach(i => fl.appendChild(card('fp', i.id, i.name, i.desc, i.installed)));
    });
    api('/api/store/search?' + qs({ q })).catch(() => ({ items: [] })).then(r => {
      dl.innerHTML = r.available === false ? '<div class="c-d">O apt não está disponível neste sistema.</div>' : r.items.length ? '' : '<div class="c-d">nada encontrado — tente "Atualizar índice" na aba Pacotes do Debian</div>';
      (r.items || []).slice(0, 30).forEach(i => dl.appendChild(card('deb', i.name, i.name, i.desc, i.installed)));
    });
  }
  async function inst() {
    scroll.innerHTML = '';
    const l = section('// APPS DO FLATHUB INSTALADOS');
    const r = await api('/api/flatpak').catch(() => ({}));
    l.innerHTML = (r.installed || []).length ? '' : '<div class="c-d">nenhum app do Flathub instalado ainda</div>';
    (r.installed || []).forEach(i => l.appendChild(card('fp', i.id, i.name, `versão ${i.version || '?'} · ${i.size || ''}`, true)));
    const n = section('// PROGRAMAS DO SISTEMA');
    n.innerHTML = '<div class="c-d">Os outros programas instalados estão em <b>Programas</b> — clique com o botão direito para desinstalar.</div>';
  }
  async function deb() {
    scroll.innerHTML = '';
    const l = section('// PACOTES DO DEBIAN');
    l.insertAdjacentHTML('beforebegin', '<div style="padding:8px 10px 0"><button class="btn upi">Atualizar índice de pacotes</button></div>');
    $('.upi', scroll).onclick = async () => { const r = await rootCall('/api/store/update', {}); if (r && r.job) await watchJob(r.job, log); };
    const ds = await api('/api/store/status?' + qs({ pkgs: DEBFEAT.map(f => f[0]).join(',') })).catch(() => ({}));
    DEBFEAT.forEach(([i, t, d]) => l.appendChild(card('deb', i, t, d, (ds.status || {})[i])));
  }
  const show = t => { tab = t; $$('.st-tabs button', body).forEach(b => b.classList.toggle('on', b.dataset.t === t)); ({ feat, inst, deb })[t](); };
  const refresh = () => tab === 'search' ? search() : show(tab);
  $$('.st-tabs button', body).forEach(b => b.onclick = () => { inp.value = ''; show(b.dataset.t); });
  $('.bs', body).onclick = search;
  inp.onkeydown = e => { if (e.key === 'Enter') search(); };
  ctx.onArg = q => { if (q) { inp.value = q; search(); } };
  if (start) { inp.value = start; search(); } else show('feat');
}};

/* ------------------------------------------------------------ Programas instalados */
APPS.programs = { name: 'Programas', icon: '⊞', kw: 'apps instalados desinstalar', w: 720, h: 480, single: true, mount(body) {
  body.innerHTML = `<div class="pg"><div class="pg-top"><input class="field" placeholder="filtrar programas… (botão direito: fixar, iniciar com o sistema, desinstalar)" spellcheck="false"></div><div class="pg-grid"><div class="c-d">${Ascii.loading('indexando programas')}</div></div></div>`;
  const grid = $('.pg-grid', body), inp = $('input', body);
  let apps = [];
  const render = () => {
    const f = norm(inp.value);
    const shown = apps.filter(a => !f || norm(`${a.name} ${a.comment} ${a.keywords}`).includes(f));
    grid.innerHTML = shown.length ? '' : ghostEmpty('Nenhum programa encontrado. Instale alguns na Loja.');
    shown.forEach(a => {
      const b = el('button', '', `<span class="pg-ic">${appIcon(a)}</span><span><b>${esc(a.name)}</b><small>${esc(a.comment || (a.terminal ? 'programa de terminal' : ''))}</small></span>`);
      b.onclick = () => launchNative(a);
      b.oncontextmenu = e => {
        e.preventDefault();
        nativeMenu(a, e.clientX, e.clientY);
        $('.ctx').appendChild(Object.assign(el('button', 'danger', 'Desinstalar…'), { onclick: async () => {
          closeCtx();
          if (!await ask({ title: `Desinstalar ${a.name}?`, text: 'O programa será removido do sistema. Seus arquivos pessoais não são apagados.', ok: 'Desinstalar', danger: true })) return;
          const r = await rootCall('/api/apps/uninstall', { id: a.id });
          if (r && r.job) { toast('Desinstalando', a.name); const j = await watchJob(r.job); if (j.code === 0) { await loadApps(true); apps = NAPPS; render(); renderAllApps(); buildDesktop(); } }
        } }));
      };
      grid.appendChild(b);
    });
  };
  inp.oninput = render;
  loadApps(true).then(r => { apps = r; render(); });
  setTimeout(() => inp.focus(), 50);
}};

/* ------------------------------------------------------------ Gerenciador de tarefas (Ctrl+Shift+Esc) */
APPS.tasks = { name: 'Tarefas', icon: '▥', kw: 'gerenciador processos travou finalizar memoria cpu', w: 760, h: 500, single: true, mount(body, ctx) {
  body.innerHTML = `<div class="tk"><div class="tk-top"><div class="tk-sum"></div><input class="field" placeholder="filtrar…" spellcheck="false"><label class="row"><input type="checkbox" class="al"> de todos os usuários</label></div>
    <div class="tk-wins"></div><div class="tk-scroll"><table><thead><tr><th data-s="name">PROCESSO</th><th data-s="pid">PID</th><th data-s="cpu">CPU ▾</th><th data-s="mem">MEMÓRIA</th><th></th></tr></thead><tbody></tbody></table></div></div>`;
  let sortK = 'cpu', alive = true, data = null;
  const inp = $('input', body), tb = $('tbody', body);
  const draw = () => {
    if (!data) return;
    const f = norm(inp.value), all = $('.al', body).checked;
    const rows = data.procs.filter(p => (all || p.mine) && (!f || norm(p.name + ' ' + p.cmd).includes(f)))
      .sort((a, b) => sortK === 'name' ? a.name.localeCompare(b.name) : sortK === 'pid' ? a.pid - b.pid : b[sortK] - a[sortK]).slice(0, 150);
    tb.innerHTML = rows.map(p => `<tr title="${esc(p.cmd)}"><td>${esc(p.name)}</td><td>${p.pid}</td><td class="${p.cpu > 50 ? 'c-h' : ''}">${p.cpu.toFixed(1)}%</td><td>${fmtSize(p.mem)}</td>
      <td>${p.mine ? `<button class="mini k" data-pid="${p.pid}" title="Pedir para fechar">finalizar</button> <button class="mini hot f" data-pid="${p.pid}" title="Fechar à força (travou)">forçar</button>` : `<small class="c-d">${esc(p.user)}</small>`}</td></tr>`).join('');
    $('.tk-sum', body).innerHTML = `CPU <b class="c-a">${Math.round(data.cpu)}%</b> · memória <b class="c-a">${(data.mem_used / 1024).toFixed(1)} de ${(data.mem_total / 1024).toFixed(1)} GB</b> · ${data.procs.length} processos`;
    $$('th', body).forEach(th => th.textContent = th.textContent.replace(' ▾', '') + (th.dataset.s === sortK ? ' ▾' : ''));
  };
  const drawWins = () => {
    const w = $('.tk-wins', body);
    w.innerHTML = NATIVE.length ? '<small class="c-d">APPS ABERTOS</small>' : '';
    NATIVE.forEach(n => {
      const c = el('span', 'tk-win', `${n.icon ? `<img src="/api/icon?${qs({ wm: n.app_id })}" alt="">` : '◇'} ${esc(n.name)} <button class="mini" title="Fechar janela">✕</button>`);
      $('button', c).onclick = () => api('/api/wm', { id: n.id, action: 'close' });
      c.onclick = e => { if (e.target.tagName !== 'BUTTON') api('/api/wm', { id: n.id, action: 'activate' }); };
      w.appendChild(c);
    });
  };
  tb.onclick = async e => {
    const b = e.target.closest('button[data-pid]'); if (!b) return;
    const r = await api('/api/procs/kill', { pid: +b.dataset.pid, force: b.classList.contains('f') });
    r.error ? toast('Não foi possível', r.error, 'err') : toast(b.classList.contains('f') ? 'Fechado à força' : 'Pedido para fechar enviado', b.closest('tr').firstChild.textContent);
    setTimeout(tick1, 600);
  };
  $$('th[data-s]', body).forEach(th => th.onclick = () => { sortK = th.dataset.s; draw(); });
  inp.oninput = draw; $('.al', body).onchange = draw;
  const tick1 = async () => { const r = await api('/api/procs').catch(() => null); if (r && r.procs) { data = r; draw(); } };
  (async () => { while (alive) { await tick1(); await sleep(2000); } })();
  drawWins(); ctx.onClose(bus.on('native', drawWins));
  ctx.onClose(() => alive = false);
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
APPS.settings = { name: 'Config', icon: '⚙', kw: 'configuracoes ajustes preferencias', w: 760, h: 520, single: true, mount(body, ctx, tab) {
  const TABS = { look: 'Aparência', fx: 'Animações', tela: 'Monitores', sound: 'Som', bt: 'Bluetooth', print: 'Impressoras', power: 'Energia',
    region: 'Teclado e hora', apps: 'Apps padrão', drv: 'Drivers', sec: 'Segurança', upd: 'Atualizações', sys: 'Sistema' };
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
      sec.insertAdjacentHTML('afterbegin', '<div><h5>POSIÇÃO DOS MONITORES (ESTENDER)</h5><div class="arr-body"></div></div>');
      arrangePanel($('.arr-body', sec));
    },
    sound() {
      sec.innerHTML = `<div><h5>SONS DA INTERFACE</h5><label class="row"><input type="checkbox" class="sf" ${SETTINGS.sound ? 'checked' : ''}> Bipes ao abrir/fechar janelas, notificações e inicialização</label>
        <div style="display:flex;gap:6px;margin-top:8px"><button class="btn" data-s="open">Abrir</button><button class="btn" data-s="notify">Notificação</button><button class="btn" data-s="error">Erro</button><button class="btn" data-s="boot">Boot</button></div></div>
        <div><h5>AMBIENTE</h5><label class="row"><input type="checkbox" class="am" ${SETTINGS.ambient ? 'checked' : ''}> Zumbido ambiente de fundo (sintetizado)</label></div>
        <div><h5>VOLUME DO SISTEMA</h5><p class="c-d">Use o ícone de som na barra de tarefas ou as teclas de volume do teclado.</p>
        <button class="btn mx">Mixer avançado (volume por app, fone, microfone)…</button></div>`;
      $('.mx', sec).onclick = () => tool('sound');
      $('.sf', sec).onchange = e => { SETTINGS.sound = e.target.checked; saveSettings(); };
      $('.am', sec).onchange = e => { SETTINGS.ambient = e.target.checked; saveSettings(); };
      $$('[data-s]', sec).forEach(b => b.onclick = () => Sfx[b.dataset.s]());
    },
    sec() {
      sec.innerHTML = `<div><h5>BLOQUEIO DE TELA</h5>
        <label class="row">Bloquear após inatividade: <select class="field li" style="width:auto">${[[0, 'nunca'], [1, '1 minuto'], [5, '5 minutos'], [10, '10 minutos'], [30, '30 minutos']].map(([v, l]) => `<option value="${v}" ${SETTINGS.lockIdle == v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="row"><input type="checkbox" class="lb" ${SETTINGS.lockOnBoot ? 'checked' : ''}> Pedir senha ao iniciar</label>
        <button class="btn ln" style="margin-top:8px">Bloquear agora</button>
        <p class="c-d">A senha é a do usuário <b>${esc(SYS.user)}</b> no Linux${SYS.live || SYS.dev ? ' (no modo live: <b>live</b>)' : ''}. Atalhos: Super+L ou Ctrl+Alt+L.</p></div>`;
      $('.li', sec).onchange = e => { SETTINGS.lockIdle = +e.target.value; saveSettings(); };
      $('.lb', sec).onchange = e => { SETTINGS.lockOnBoot = e.target.checked; saveSettings(); };
      $('.ln', sec).onclick = () => Lock.show();
      sec.insertAdjacentHTML('beforeend', `<div class="fwb"><h5>FIREWALL</h5><div class="c-d">verificando…</div></div>
        <div><h5>TROCAR SENHA</h5><div class="pwf"><input class="field cu" type="password" placeholder="senha atual" autocomplete="off">
        <input class="field n1" type="password" placeholder="senha nova" autocomplete="off"><input class="field n2" type="password" placeholder="repita a senha nova" autocomplete="off">
        <button class="btn pwb">Trocar senha</button></div><p class="c-d" style="font-size:11px">Vale para o bloqueio de tela, o sudo e o login.</p></div>`);
      const fw = async () => {
        const f = await api('/api/firewall').catch(() => ({})), box = $('.fwb', sec); if (!box) return;
        box.innerHTML = '<h5>FIREWALL</h5>' + (f.available ? `<label class="row"><input type="checkbox" class="fwc" ${f.enabled ? 'checked' : ''}> Bloquear conexões vindas da rede (recomendado em Wi-Fi público)</label>
          <p class="c-d" style="font-size:11px">Não atrapalha navegar, jogar online nem baixar.</p>` : '<p class="c-d">ufw não instalado.</p>');
        if ($('.fwc', box)) $('.fwc', box).onchange = async e => { const r = await rootCall('/api/firewall', { on: e.target.checked }); if (r && !r.error) toast(r.enabled ? 'Firewall ligado' : 'Firewall desligado', '', 'ok'); fw(); };
      };
      fw();
      $('.pwb', sec).onclick = async () => {
        const [c, a, b] = ['.cu', '.n1', '.n2'].map(k => $(k, sec).value);
        if (!c || !a) return toast('Preencha as senhas', '', 'err');
        if (a !== b) return toast('As senhas novas não são iguais', '', 'err');
        const r = await api('/api/account/password', { current: c, new: a });
        if (r.error) return toast('Senha não trocada', r.error, 'err');
        ['.cu', '.n1', '.n2'].forEach(k => $(k, sec).value = ''); toast('Senha trocada', 'Use a nova a partir de agora', 'ok');
      };
    },
    upd() {
      sec.innerHTML = `<div class="deb"><h5>SISTEMA DEBIAN</h5><div>${Ascii.loading('consultando o apt')}</div></div>
        <div class="fpk"><h5>APPS DO FLATHUB</h5><div>${Ascii.loading('consultando o Flathub')}</div></div>
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
      const fpk = async () => {
        const box = $('.fpk > div', sec), f = await api('/api/flatpak/updates').catch(() => ({ available: false }));
        if (!box) return;
        if (!f.available) { box.innerHTML = '<p class="c-d">Flatpak indisponível.</p>'; return; }
        box.innerHTML = `<p>${f.count ? `<b class="c-a">${f.count}</b> app(s) com versão nova: <span class="c-d">${f.items.slice(0, 8).map(i => esc(i.name || i.id)).join(' · ')}</span>` : '<span class="c-o">✓ tudo em dia</span>'}</p>
          <button class="btn hot fu" ${f.count ? '' : 'disabled'}>Atualizar apps</button>`;
        $('.fu', box).onclick = async () => { busy(true); const r = await api('/api/flatpak/update', {}); if (r.job) await watchJob(r.job, log); busy(false); fpk(); };
      };
      deb(); neo(); fpk();
    },
    async bt() {
      sec.innerHTML = `<div class="btb"><h5>BLUETOOTH</h5><div>${Ascii.loading('procurando adaptador')}</div></div>`;
      const ICO = { 'audio-headset': 'Ω', 'audio-headphones': 'Ω', 'audio-card': '♫', 'input-gaming': '◈', 'input-mouse': '◉', 'input-keyboard': '⌨', phone: '▯', computer: '▭' };
      let until = 0;
      const draw = async () => {
        const box = $('.btb > div', sec); if (!box) return false;
        const s = await api('/api/bt').catch(() => ({ available: false }));
        if (!$('.btb', sec)) return false;
        if (!s.available) { box.innerHTML = `<p class="c-d">${esc(s.reason || 'Bluetooth indisponível')}</p>`; return false; }
        box.innerHTML = `<label class="row"><input type="checkbox" class="pw" ${s.powered ? 'checked' : ''}> Bluetooth ligado</label>
          ${s.powered ? `<button class="btn sc" ${s.scanning ? 'disabled' : ''}>${s.scanning ? 'procurando aparelhos…' : 'Procurar aparelhos'}</button>` : ''}
          <div class="bt-list"></div><p class="c-d" style="font-size:11px">Para parear: coloque o fone, controle ou caixa em modo de pareamento e clique em <b>Conectar</b>.</p>
          <button class="btn adv">Bluetooth avançado (Blueman)…</button>`;
        const list = $('.bt-list', box);
        if (s.powered && !s.devices.length) list.innerHTML = '<p class="c-d">nenhum aparelho por perto — clique em Procurar</p>';
        s.devices.forEach(d => {
          const r = el('div', 'bt-dev' + (d.connected ? ' on' : ''), `<span class="bi">${ICO[d.icon] || '◇'}</span><div><b>${esc(d.name)}</b><small>${d.connected ? 'conectado' : d.paired ? 'pareado' : 'disponível'}${d.battery != null ? ` · bateria ${d.battery}%` : ''}</small></div>
            <button class="mini cn">${d.connected ? 'desconectar' : 'conectar'}</button>${d.paired ? '<button class="mini hot rm" title="Esquecer este aparelho">esquecer</button>' : ''}`);
          $('.cn', r).onclick = async e => {
            e.target.textContent = d.connected ? 'desconectando…' : 'conectando…'; e.target.disabled = true;
            const x = await api('/api/bt/action', { mac: d.mac, action: d.connected ? 'disconnect' : 'connect' });
            x.error ? toast('Bluetooth', x.error, 'err') : toast(d.connected ? 'Desconectado' : 'Conectado', d.name, 'ok'); draw();
          };
          if ($('.rm', r)) $('.rm', r).onclick = async () => { await api('/api/bt/action', { mac: d.mac, action: 'remove' }); draw(); };
          list.appendChild(r);
        });
        $('.pw', box).onchange = async e => { const x = await api('/api/bt/power', { on: e.target.checked }); if (x.error) toast('Bluetooth', x.error, 'err'); setTimeout(draw, 800); };
        if ($('.sc', box)) $('.sc', box).onclick = async () => { await api('/api/bt/scan', {}); until = Date.now() + 21000; draw(); };
        $('.adv', box).onclick = () => tool('bluetooth');
        return true;
      };
      if (await draw()) (async () => { while (sec.isConnected && $('.btb', sec)) { await sleep(3000); if (Date.now() < until && sec.isConnected && $('.btb', sec)) await draw(); } })();
    },
    async print() {
      sec.innerHTML = `<div class="prb"><h5>IMPRESSORAS</h5><div>${Ascii.loading('consultando impressoras')}</div></div>
        <div><h5>SCANNER</h5><p class="c-d">Scanners e multifuncionais da rede ou USB.</p><button class="btn scn">Abrir digitalizador</button></div>`;
      $('.scn', sec).onclick = () => tool('scanner');
      const draw = async () => {
        const box = $('.prb > div', sec), r = await api('/api/printers').catch(() => ({ available: false }));
        if (!box) return;
        if (!r.available) { box.innerHTML = '<p class="c-d">Sistema de impressão (CUPS) indisponível.</p>'; return; }
        box.innerHTML = (r.printers.length ? '' : '<p class="c-d">Nenhuma impressora ainda. As de rede (Wi-Fi) e USB modernas aparecem sozinhas em alguns segundos depois de ligadas.</p>')
          + `<div class="pr-list"></div>${r.jobs ? `<p class="c-w">${r.jobs} trabalho(s) na fila de impressão</p>` : ''}<button class="btn add">Adicionar impressora…</button>`;
        r.printers.forEach(pr => {
          const row = el('div', 'bt-dev', `<span class="bi">⎙</span><div><b>${esc(pr.name)}${pr.default ? ' <span class="c-o">· padrão</span>' : ''}</b><small>${esc(pr.state)}</small></div>
            <button class="mini" data-a="test">página de teste</button>${pr.default ? '' : '<button class="mini" data-a="default">tornar padrão</button>'}<button class="mini" data-a="cancel">limpar fila</button><button class="mini hot" data-a="remove">remover</button>`);
          $$('[data-a]', row).forEach(b => b.onclick = async () => {
            if (b.dataset.a === 'remove' && !await ask({ title: `Remover ${pr.name}?`, ok: 'Remover', danger: true })) return;
            const x = await rootCall('/api/printers/action', { name: pr.name, action: b.dataset.a });
            if (x && x.ok) toast({ test: 'Página de teste enviada', default: 'Impressora padrão', cancel: 'Fila limpa', remove: 'Impressora removida' }[b.dataset.a], pr.name, 'ok');
            draw();
          });
          $('.pr-list', box).appendChild(row);
        });
        $('.add', box).onclick = () => tool('printers');
      };
      draw();
    },
    async power() {
      const s = await api('/api/power/settings').catch(() => ({}));
      const opt = (k, vals) => `<select class="field" data-k="${k}" style="width:auto">${vals.map(([v, l]) => `<option value="${v}" ${+s[k] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
      const PN = { 'power-saver': 'Economia', balanced: 'Equilibrado', performance: 'Desempenho' };
      sec.innerHTML = `<div><h5>MODO DE ENERGIA</h5>${s.profiles && s.profiles.options.length ? `<div class="fx-pick">${s.profiles.options.map(o => `<button data-p="${esc(o)}" class="${o === s.profiles.current ? 'on' : ''}">${PN[o] || esc(o)}</button>`).join('')}</div>
          <p class="c-d">Desempenho: mais FPS nos jogos. Economia: bateria dura mais.</p>` : '<p class="c-d">Controle de energia indisponível neste sistema.</p>'}</div>
        <div><h5>QUANDO VOCÊ SAI DO COMPUTADOR</h5>
          <label class="row">Desligar a tela após: ${opt('screen_off', [[0, 'nunca'], [1, '1 minuto'], [2, '2 minutos'], [5, '5 minutos'], [10, '10 minutos'], [15, '15 minutos'], [30, '30 minutos'], [60, '1 hora']])}</label>
          <label class="row">Suspender após: ${opt('suspend', [[0, 'nunca'], [10, '10 minutos'], [15, '15 minutos'], [30, '30 minutos'], [60, '1 hora'], [120, '2 horas']])}</label>
          <label class="row"><input type="checkbox" data-c="lock_on_suspend" ${s.lock_on_suspend ? 'checked' : ''}> Bloquear a tela ao suspender</label>
          <p class="c-d">Vídeos e jogos em tela cheia impedem que a tela apague. Protetor de tela: aba Animações · bloqueio automático: aba Segurança.</p></div>
        <div><h5>LUZ NOTURNA</h5>${s.night_ok ? `<label class="row"><input type="checkbox" class="nt" ${s.night ? 'checked' : ''}> Tela mais quente à noite (menos luz azul)</label>
          <label class="row">Intensidade: <input type="range" class="ntt" min="2800" max="5800" step="100" value="${s.night_temp}" style="direction:rtl;width:180px"></label>` : '<p class="c-d">indisponível</p>'}</div>
        ${s.battery ? `<div><h5>BATERIA</h5><p>${s.battery.level}% ${s.battery.charging ? '· carregando' : ''}</p></div>` : ''}`;
      $$('[data-p]', sec).forEach(b => b.onclick = async () => { $$('[data-p]', sec).forEach(x => x.classList.toggle('on', x === b)); await api('/api/power/settings', { profile: b.dataset.p }); toast('Modo de energia', b.textContent, 'ok'); });
      $$('select[data-k]', sec).forEach(x => x.onchange = () => api('/api/power/settings', { [x.dataset.k]: +x.value }));
      $$('[data-c]', sec).forEach(x => x.onchange = () => api('/api/power/settings', { [x.dataset.c]: x.checked }));
      if ($('.nt', sec)) { $('.nt', sec).onchange = e => api('/api/power/settings', { night: e.target.checked }); $('.ntt', sec).onchange = e => api('/api/power/settings', { night_temp: +e.target.value }); }
    },
    async region() {
      const r = await api('/api/region').catch(() => ({}));
      sec.innerHTML = `<div><h5>DATA E HORA</h5><p>Agora: <b class="c-a now"></b></p>
          <label class="row"><input type="checkbox" class="ntp" ${r.ntp ? 'checked' : ''}> Acertar o relógio automaticamente pela internet</label>
          <label class="row">Fuso horário: <select class="field tz" style="width:auto"><option>${esc(r.timezone || '?')}</option></select></label>
          <label class="row"><input type="checkbox" class="cs" ${SETTINGS.clockSec ? 'checked' : ''}> Mostrar os segundos no relógio da barra</label></div>
        <div><h5>TECLADO</h5><label class="row">Layout: <select class="field kb" style="width:auto">${(r.layouts || []).map(l => `<option value="${l.layout}|${l.variant}" ${l.layout === r.layout && l.variant === (r.variant || '') ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
          <p class="c-d">Muda na hora, para todos os apps. Teste aqui:</p><input class="field" placeholder="ç á ã é ô ~ ´ ^ ?" style="width:260px"></div>`;
      const now = $('.now', sec), tick = () => { if (now.isConnected) { now.textContent = new Date().toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'medium' }); setTimeout(tick, 1000); } }; tick();
      api('/api/region/zones').then(z => { const sel = $('.tz', sec); if (!sel || !z.zones || !z.zones.length) return; sel.innerHTML = z.zones.map(t => `<option ${t === r.timezone ? 'selected' : ''}>${esc(t)}</option>`).join(''); }).catch(() => {});
      $('.tz', sec).onchange = async e => { const x = await rootCall('/api/region', { timezone: e.target.value }); if (x && x.ok) toast('Fuso horário', e.target.value, 'ok'); };
      $('.ntp', sec).onchange = async e => { const x = await rootCall('/api/region', { ntp: e.target.checked }); if (x && x.ok) toast('Relógio', e.target.checked ? 'acerto automático ligado' : 'acerto automático desligado', 'ok'); };
      $('.cs', sec).onchange = e => { SETTINGS.clockSec = e.target.checked; saveSettings(); };
      $('.kb', sec).onchange = async e => { const [layout, variant] = e.target.value.split('|'); const x = await api('/api/region', { layout, variant }); x.error ? toast('Erro', x.error, 'err') : toast('Layout do teclado trocado', e.target.selectedOptions[0].textContent, 'ok'); };
    },
    async apps() {
      sec.innerHTML = `<div class="dfl"><h5>APPS PADRÃO</h5><div>${Ascii.loading('consultando')}</div></div>
        <div class="aut"><h5>ABRIR AO LIGAR O COMPUTADOR</h5><div></div></div>`;
      api('/api/defaults').then(d => {
        const box = $('.dfl > div', sec); if (!box || !d.kinds) return;
        box.innerHTML = '<div class="dfl-grid"></div><p class="c-d" style="font-size:11px">Também dá para escolher pelo botão direito → "Abrir com…" em Arquivos.</p>';
        Object.entries(d.kinds).forEach(([k, v]) => {
          const row = el('label', 'row', `<span style="width:90px">${esc(v.label)}</span><select class="field" style="width:auto">${v.apps.length ? '' : '<option>nenhum app</option>'}${v.apps.map(a => `<option value="${esc(a.id)}" ${a.id === v.current ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`);
          $('select', row).onchange = async e => { const x = await api('/api/defaults', { kind: k, app: e.target.value }); x.error ? toast('Erro', x.error, 'err') : toast('App padrão', `${v.label}: ${e.target.selectedOptions[0].textContent}`, 'ok'); };
          $('.dfl-grid', box).appendChild(row);
        });
      }).catch(() => {});
      const aut = async (r) => {
        const box = $('.aut > div', sec); if (!box) return;
        r = r || await api('/api/autostart').catch(() => ({ items: [] }));
        const apps = await loadApps();
        box.innerHTML = (r.items.length ? '' : '<p class="c-d">nenhum app abre sozinho</p>') + '<div class="au-list"></div>'
          + `<div style="display:flex;gap:6px;margin-top:8px"><select class="field ad" style="width:auto"><option value="">escolha um app…</option>${apps.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select><button class="btn add">Adicionar</button></div>`;
        r.items.forEach(i => { const row = el('div', 'bt-dev', `<span class="bi">▸</span><div><b>${esc(i.name)}</b><small>${i.enabled ? 'abre ao ligar' : 'desativado'}</small></div><button class="mini hot">tirar</button>`);
          $('button', row).onclick = async () => aut(await api('/api/autostart', { remove: i.id })); $('.au-list', box).appendChild(row); });
        $('.add', box).onclick = async () => { const v = $('.ad', box).value; if (v) aut(await api('/api/autostart', { add: v })); };
      };
      aut();
    },
    async drv() {
      sec.innerHTML = `<div><h5>PLACA DE VÍDEO</h5><div class="c-d">${Ascii.loading('detectando hardware')}</div></div>`;
      const d = await api('/api/drivers').catch(() => ({ gpus: [] }));
      sec.innerHTML = `<div><h5>PLACA DE VÍDEO</h5>${(d.gpus || []).map(g => `<p>▸ ${esc(g.name)}</p>`).join('') || '<p class="c-d">não detectada</p>'}</div>`
        + (d.nvidia ? `<div><h5>DRIVER NVIDIA</h5>
            <p>${d.loaded ? '<span class="c-o">● driver da NVIDIA ativo</span>' : d.installed ? '<span class="c-w">instalado — reinicie o computador para ativar</span>' : 'Hoje está usando o driver livre (nouveau): funciona, mas é lento para jogos.'}</p>
            ${d.note ? `<p class="c-w">${esc(d.note)}</p>` : ''}${d.live ? '<p class="c-d">No modo live (pendrive) não dá: instale o NeonOS no disco primeiro.</p>' : ''}
            ${d.secure_boot ? '<p class="c-h">O Secure Boot está ligado: desligue na BIOS, senão o driver da NVIDIA não carrega.</p>' : ''}
            <div style="display:flex;gap:6px"><button class="btn hot ins" ${d.live || d.installed || d.note ? 'disabled' : ''}>Instalar driver NVIDIA</button>${d.installed ? '<button class="btn rmv">Remover driver</button>' : ''}</div><pre class="log"></pre></div>`
          : `<div><h5>DRIVERS</h5><p class="c-o">✓ Placas AMD e Intel já funcionam com os drivers do próprio Linux (Mesa, com Vulkan para jogos). Nada para instalar.</p></div>`)
        + `<div><h5>FIRMWARE E PROCESSADOR</h5><p>${d.microcode ? '✓ correções de microcódigo do processador instaladas' : 'microcódigo do processador não instalado'}</p>
          <p class="c-d">Firmware de Wi-Fi, Bluetooth e som (Intel, Realtek, Atheros, Broadcom, MediaTek) já vem no NeonOS.</p></div>`;
      const run = async action => {
        if (!await ask({ title: action === 'install' ? 'Instalar driver NVIDIA?' : 'Remover driver NVIDIA?', text: action === 'install' ? `Vai baixar e compilar o driver (${d.package}) — leva alguns minutos. Depois é preciso reiniciar.` : 'Volta para o driver livre (nouveau) depois de reiniciar.', ok: action === 'install' ? 'Instalar' : 'Remover', danger: action !== 'install' })) return;
        const r = await rootCall('/api/drivers', { action });
        if (r && r.job) { const j = await watchJob(r.job, $('.log', sec)); if (j.code === 0) toast('Pronto', 'Reinicie o computador para usar o driver novo', 'ok'); R.drv(); }
      };
      if ($('.ins', sec)) $('.ins', sec).onclick = () => run('install');
      if ($('.rmv', sec)) $('.rmv', sec).onclick = () => run('remove');
    },
    async sys() {
      sec.innerHTML = `<div><h5>SISTEMA</h5><div class="kv"><span>Sistema</span><span>${esc(SYS.os)}</span><span>Kernel</span><span>${esc(SYS.kernel)}</span><span>Shell</span><span>${esc(SYS.shell)}</span>
        <span>Usuário</span><span>${esc(SYS.user)}@${esc(SYS.host)}</span><span>Modo</span><span>${SYS.live ? 'Live (pendrive)' : 'Instalado'}</span></div></div>
        <div class="hw"><h5>COMPUTADOR</h5><div class="c-d">lendo hardware…</div></div>
        <div><h5>FERRAMENTAS</h5><div class="tools"><button class="btn" data-t="disks">Discos e pendrives</button><button class="btn" data-t="partitions">Partições (GParted)</button>
          <button class="btn" data-t="backup">Backup do sistema (Timeshift)</button><button class="btn tk">Gerenciador de tarefas</button></div>
          <p class="c-d" style="font-size:11px">O Timeshift guarda "fotos" do sistema: se uma atualização ou experiência der errado, você volta como estava.</p></div>
        <div class="ps"><h5>PERSISTÊNCIA</h5><div class="c-d">verificando…</div></div>
        ${SYS.live ? '<div><h5>INSTALAÇÃO</h5><button class="btn inst">Instalar no disco…</button></div>' : ''}`;
      if ($('.inst', sec)) $('.inst', sec).onclick = () => openApp('installer');
      $$('.tools [data-t]', sec).forEach(b => b.onclick = () => tool(b.dataset.t));
      $('.tk', sec).onclick = () => openApp('tasks');
      api('/api/hardware').then(h => { const box = $('.hw', sec); if (!box || h.error) return;
        box.innerHTML = `<h5>COMPUTADOR</h5><div class="kv">${h.machine ? `<span>Modelo</span><span>${esc(h.machine)}</span>` : ''}<span>Processador</span><span>${esc(h.cpu || '?')} · ${h.cores} núcleos</span>
          <span>Memória</span><span>${(h.mem_total / 1024).toFixed(1)} GB</span>${(h.gpus || []).map(g => `<span>Vídeo</span><span>${esc(g)}</span>`).join('')}
          ${h.disk ? `<span>Disco</span><span>${fmtSize(h.disk.used)} usados de ${fmtSize(h.disk.total)}</span>` : ''}</div>`; }).catch(() => {});
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
  const tool = t => api('/api/tool', { tool: t }).then(r => r.error ? toast('Não abriu', r.error, 'err') : toast('Abrindo', '')).catch(() => {});
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
