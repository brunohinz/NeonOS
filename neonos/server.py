#!/usr/bin/env python3
"""NeonOS backend — serve a interface e faz a ponte com o Linux.

Escuta só em 127.0.0.1 e roda como o usuário logado. Tarefas de root
(instalar programas, persistência, rede) passam por sudo com a senha do usuário.
"""
import codecs, fcntl, glob, json, mimetypes, os, platform, pty, pwd, re, select, shlex, shutil
import signal, stat, struct, subprocess, sys, tarfile, termios, threading, time, uuid, zipfile
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote, unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
import wl  # noqa: E402  (janelas dos apps nativos)
PORT = int(os.environ.get("NEONOS_PORT", "8080"))
HOME = os.path.expanduser("~")
USER = pwd.getpwuid(os.getuid()).pw_name
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
IS_ROOT = os.geteuid() == 0
IS_LINUX = platform.system() == "Linux"
LIVE = os.path.isdir("/run/live/medium")
CHKPWD = next((p for p in ("/usr/sbin/unix_chkpwd", "/sbin/unix_chkpwd") if os.path.exists(p)), None)
os.environ["PATH"] = os.environ.get("PATH", "/usr/bin:/bin") + ":/usr/local/sbin:/usr/sbin:/sbin"
for ext, typ in ((".opus", "audio/ogg"), (".flac", "audio/flac"), (".m4a", "audio/mp4"),
                 (".mkv", "video/x-matroska"), (".webm", "video/webm"), (".webp", "image/webp")):
    mimetypes.add_type(typ, ext)


# ---------------------------------------------------------------- utilidades
def which(cmd):
    return shutil.which(cmd)


def run(args, timeout=20, input=None, env=None):
    kw = {"input": input} if input is not None else {"stdin": subprocess.DEVNULL}
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env, **kw)
        return p.returncode, p.stdout + p.stderr
    except FileNotFoundError:
        return 127, f"{args[0]}: não encontrado"
    except subprocess.TimeoutExpired:
        return 124, "tempo esgotado"


def as_root(args, password=None, timeout=60):
    if IS_ROOT:
        return run(args, timeout)
    env = dict(os.environ, LC_ALL="C", LANG="C")  # mensagens do sudo em inglês (o código procura "password")
    if password:
        return run(["sudo", "-S", "-p", "", *args], timeout, input=password + "\n", env=env)
    return run(["sudo", "-n", *args], timeout, env=env)


def read(path, default=None):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def P(path):
    return os.path.abspath(os.path.expanduser(path or "~"))


def os_name():
    for line in (read("/etc/os-release", "") or "").splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip('"')
    return f"{platform.system()} {platform.mac_ver()[0]}".strip()


def bash_version():
    code, out = run(["bash", "-c", "echo ${BASH_VERSION%%(*}"])
    return f"bash {out.strip()}" if code == 0 else "bash"


VERSION = (read(os.path.join(ROOT, "VERSION"), "0.0.0") or "0.0.0").strip()
SYS = {"ok": True, "version": VERSION, "home": HOME, "user": USER, "host": platform.node().split(".")[0],
       "kernel": f"{platform.system()} {platform.release()}", "shell": bash_version(),
       "os": os_name(), "live": LIVE, "dev": CHKPWD is None, "linux": IS_LINUX}

if IS_LINUX:  # pastas padrão do usuário
    for d in ("Documentos", "Downloads", "Música", "Vídeos", "Imagens"):
        safe(lambda: os.makedirs(os.path.join(HOME, d), exist_ok=True))


# ---------------------------------------------------------------- eventos / tarefas
EVENTS, _ev = [], {"seq": 0}
_ev_cond = threading.Condition()


def wm_changed():
    with _ev_cond:
        _ev_cond.notify_all()


WM = wl.Toplevels(on_change=wm_changed)


def emit(title, body="", kind="info", data=None):
    with _ev_cond:
        _ev["seq"] += 1
        EVENTS.append({"id": _ev["seq"], "title": str(title)[:120], "body": str(body)[:300], "kind": kind, "data": data})
        del EVENTS[:-60]
        _ev_cond.notify_all()
    if kind in ("info", "ok", "err") and WM.ok and WM.above_shell():
        desktop_notify(title, body, kind)


def desktop_notify(title, body="", kind="info"):
    """Notificação por cima de tudo (mako), usada quando um app nativo cobre a interface."""
    if which("notify-send"):
        spawn(["notify-send", "-a", "NeonOS", "-u", "critical" if kind == "err" else "normal",
               str(title)[:120], str(body)[:300]])


def events_since(since, wm=-1, wait=False):
    """Com wait, segura a resposta até chegar um evento ou mudar a lista de janelas (máx. 25 s)."""
    end = time.time() + 25
    with _ev_cond:
        while wait and _ev["seq"] <= since and WM.seq == wm and time.time() < end:
            _ev_cond.wait(max(0.1, end - time.time()))
    return {"events": [e for e in EVENTS if e["id"] > since], "last": _ev["seq"], "wm": WM.seq}


JOBS = {}


def start_job(title, args, password=None, root=True, env=None):
    jid = uuid.uuid4().hex[:8]
    job = JOBS[jid] = {"id": jid, "title": title, "log": "", "done": False, "code": None}

    def worker():
        cmd = args
        if root and not IS_ROOT:
            cmd = ["sudo", "-S", "-p", "", *args] if password else ["sudo", "-n", *args]
        try:
            p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, bufsize=1, env=env)
            if password and root:
                p.stdin.write(password + "\n")
            p.stdin.close()
            for line in p.stdout:
                job["log"] = (job["log"] + line)[-30000:]
            job["code"] = p.wait()
        except Exception as e:
            job["log"] += f"\nerro: {e}"
            job["code"] = 1
        job["done"] = True
        if job["code"] == 0:
            emit(f"{title}: concluído", "", "ok")
        else:
            last = job["log"].strip().splitlines()
            emit(f"{title}: falhou", last[-1] if last else "", "err")

    threading.Thread(target=worker, daemon=True).start()
    return job


def user_job(title, args, env=None):
    return {"job": start_job(title, args, root=False, env=env)["id"]}


def py_job(title, fn):
    """Tarefa em Python com barra de progresso (copiar, compactar, extrair...)."""
    jid = uuid.uuid4().hex[:8]
    job = JOBS[jid] = {"id": jid, "title": title, "log": "", "done": False, "code": None, "progress": 0.0}

    def worker():
        t0 = time.time()
        try:
            fn(job)
            job["code"] = 0
        except Exception as e:
            job["log"] += f"\nerro: {e}"
            job["code"] = 1
        job["progress"], job["done"] = 1.0, True
        if job["code"]:
            emit(f"{title}: falhou", job["log"].strip().splitlines()[-1], "err")
        elif time.time() - t0 > 3:
            emit(f"{title}: concluído", "", "ok")
        emit("fs", "", "ui")

    threading.Thread(target=worker, daemon=True).start()
    return {"job": jid}


def root_job(title, args, password):
    code, _ = as_root(["true"], password, 15)
    if code != 0:
        return {"need_password": True}
    return {"job": start_job(title, args, password)["id"]}


# ---------------------------------------------------------------- estatísticas
_prev_cpu = [None]


def cpu_percent():
    with open("/proc/stat") as f:
        v = list(map(int, f.readline().split()[1:]))
    idle, total = v[3] + v[4], sum(v)
    prev, _prev_cpu[0] = _prev_cpu[0], (idle, total)
    if prev is None or total == prev[1]:
        return 0.0
    return round(100 * (1 - (idle - prev[0]) / (total - prev[1])), 1)


def meminfo():
    m = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            m[k] = int(v.split()[0])
    return (m["MemTotal"] - m["MemAvailable"]) // 1024, m["MemTotal"] // 1024


def procs(limit=8):
    out = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            name, rss = "?", 0
            with open(f"/proc/{pid}/status") as f:
                for line in f:
                    if line.startswith("Name:"):
                        name = line.split()[1]
                    elif line.startswith("VmRSS:"):
                        rss = int(line.split()[1])
            out.append({"pid": int(pid), "name": name, "rss": round(rss / 1024, 1)})
        except OSError:
            pass
    return sorted(out, key=lambda p: -p["rss"])[:limit]


def net_bytes():
    rx = tx = 0
    with open("/proc/net/dev") as f:
        for line in f.readlines()[2:]:
            name, data = line.split(":", 1)
            if name.strip() == "lo":
                continue
            fields = data.split()
            rx, tx = rx + int(fields[0]), tx + int(fields[8])
    return rx, tx


def battery():
    for b in sorted(glob.glob("/sys/class/power_supply/BAT*")):
        cap = read(b + "/capacity")
        if cap:
            return {"level": int(cap), "charging": read(b + "/status", "") in ("Charging", "Full")}
    return None


def temperature():
    vals = [int(read(p, "0") or 0) / 1000 for p in glob.glob("/sys/class/thermal/thermal_zone*/temp")]
    vals = [v for v in vals if 0 < v < 150]
    return round(max(vals), 1) if vals else None


def stats():
    mem = safe(meminfo, (0, 0))
    rx, tx = safe(net_bytes, (0, 0))
    du = safe(lambda: shutil.disk_usage(HOME))
    return {"cpu": safe(cpu_percent, 0), "mem_used": mem[0], "mem_total": mem[1],
            "uptime": safe(lambda: float(read("/proc/uptime").split()[0]), 0),
            "procs": safe(procs, []), "net_rx": rx, "net_tx": tx, "temp": safe(temperature),
            "battery": safe(battery), "load": safe(lambda: round(os.getloadavg()[0], 2)),
            "cores": os.cpu_count(),
            "disk": {"used": du.used // 2**20, "total": du.total // 2**20} if du else None}


# ---------------------------------------------------------------- arquivos
MEDIA_EXT = {".mp3", ".ogg", ".opus", ".flac", ".wav", ".m4a", ".aac", ".mp4", ".webm", ".mkv", ".mov"}
VIDEO_EXT = {".mp4", ".webm", ".mkv", ".mov"}


def fs_list(path, hidden=False):
    path = P(path)
    items = []
    for e in os.scandir(path):
        if not hidden and e.name.startswith("."):
            continue
        try:
            st, isdir = e.stat(), e.is_dir()
        except OSError:
            continue
        items.append({"name": e.name, "dir": isdir, "size": st.st_size, "mtime": int(st.st_mtime),
                      "link": e.is_symlink(), "exec": not isdir and bool(st.st_mode & 0o111)})
    items.sort(key=lambda i: (not i["dir"], i["name"].lower()))
    return {"path": path, "items": items}


def fs_read(path):
    path = P(path)
    if os.path.getsize(path) > 5 * 2**20:
        raise ValueError("arquivo grande demais para o editor (> 5 MB)")
    with open(path, "rb") as f:
        data = f.read()
    return {"path": path, "content": data.decode("utf-8", "replace"), "binary": b"\0" in data[:4096]}


def fs_write(b):
    path = P(b["path"])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(b.get("content", ""))
    return {"ok": True, "path": path}


def fs_mkdir(b):
    os.makedirs(P(b["path"]), exist_ok=False)
    return {"ok": True}


def fs_touch(b):
    path = P(b["path"])
    if os.path.exists(path):
        raise ValueError("já existe")
    open(path, "x").close()
    return {"ok": True, "path": path}


def fs_rename(b):
    src = P(b["path"])
    dst = os.path.join(os.path.dirname(src), os.path.basename(b["name"]))
    if os.path.exists(dst):
        raise ValueError("já existe um item com esse nome")
    os.rename(src, dst)
    return {"ok": True, "path": dst}


def media_scan(path=None):
    dirs = [P(path)] if path else [os.path.join(HOME, d) for d in ("Música", "Musica", "Music", "Vídeos", "Videos", "Downloads")]
    out = []
    for d in dirs:
        for root, _, files in os.walk(d):
            for f in sorted(files):
                ext = os.path.splitext(f)[1].lower()
                if ext in MEDIA_EXT:
                    out.append({"path": os.path.join(root, f), "name": f, "video": ext in VIDEO_EXT})
            if len(out) > 500:
                break
    return {"items": out[:500]}


# ---------------------------------------------------------------- terminal (PTY)
PTYS = {}


class Pty:
    def __init__(self, cols, rows, cwd=None, cmd=None):
        argv = ["bash", "-ic", cmd] if cmd else ["bash", "-i"]
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(cwd if cwd and os.path.isdir(cwd) else HOME)
                env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
                os.execvpe("bash", argv, env)
            finally:
                os._exit(1)
        self.pid, self.fd = pid, fd
        self.dec = codecs.getincrementaldecoder("utf-8")("replace")
        self.lock = threading.Lock()
        self.resize(cols, rows)

    def resize(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(2, int(rows)), max(2, int(cols)), 0, 0))

    def read(self, timeout=20):
        with self.lock:
            if not select.select([self.fd], [], [], timeout)[0]:
                return ""
            chunks = []
            while True:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    if chunks:
                        break
                    raise EOFError
                chunks.append(data)
                if len(chunks) > 16 or not select.select([self.fd], [], [], 0.01)[0]:
                    break
            return self.dec.decode(b"".join(chunks))

    def write(self, data):
        buf = data.encode()
        while buf:
            n = os.write(self.fd, buf)
            buf = buf[n:]

    def close(self):
        safe(lambda: os.kill(self.pid, signal.SIGHUP))
        safe(lambda: os.close(self.fd))
        threading.Thread(target=lambda: safe(lambda: os.waitpid(self.pid, 0)), daemon=True).start()


def pty_new(b):
    pid = uuid.uuid4().hex[:10]
    PTYS[pid] = Pty(b.get("cols", 80), b.get("rows", 24), b.get("cwd"), b.get("cmd"))
    return {"id": pid}


def pty_read(pid):
    p = PTYS.get(pid)
    if not p:
        return {"exit": True}
    try:
        return {"data": p.read()}
    except EOFError:
        PTYS.pop(pid, None)
        p.close()
        return {"exit": True}


def pty_call(b, fn):
    p = PTYS.get(b.get("id"))
    if p:
        fn(p)
    return {"ok": bool(p)}


def pty_close(b):
    p = PTYS.pop(b.get("id"), None)
    if p:
        p.close()
    return {"ok": True}


# ---------------------------------------------------------------- rede (NetworkManager)
def nm_split(line):
    return [f.replace("\\:", ":") for f in re.split(r"(?<!\\):", line)]


def net_status(quick=False):
    if not which("nmcli"):
        return {"available": False}
    _, out = run(["nmcli", "-t", "-f", "TYPE,STATE,CONNECTION", "dev"])
    kind, name = None, ""
    for f in map(nm_split, out.splitlines()):
        if len(f) >= 3 and f[1] == "connected" and f[0] in ("ethernet", "wifi"):
            if kind is None or f[0] == "ethernet":
                kind, name = f[0], f[2]
    if quick:
        signal_ = 0
        if kind == "wifi":
            _, out = run(["nmcli", "-t", "-f", "IN-USE,SIGNAL", "dev", "wifi", "list", "--rescan", "no"])
            for f in map(nm_split, out.splitlines()):
                if f[0] == "*" and len(f) > 1:
                    signal_ = int(f[1] or 0)
        return {"available": True, "kind": kind, "name": name, "signal": signal_}
    _, radio = run(["nmcli", "radio", "wifi"])
    wifi_on = radio.strip() == "enabled"
    nets, seen = [], set()
    if wifi_on:
        _, out = run(["nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "dev", "wifi", "list"], 20)
        for f in map(nm_split, out.splitlines()):
            if len(f) < 4 or not f[1] or f[1] in seen:
                continue
            seen.add(f[1])
            nets.append({"active": f[0] == "*", "ssid": f[1], "signal": int(f[2] or 0), "secure": f[3] not in ("", "--")})
    nets.sort(key=lambda n: (not n["active"], -n["signal"]))
    return {"available": True, "wifi_on": wifi_on, "networks": nets, "ethernet": kind == "ethernet"}


def nm_maybe_root(args, password, timeout=45):
    code, out = run(args, timeout)
    if code != 0 and "not authorized" in out.lower():
        code, out = as_root(args, password, timeout)
        if code != 0 and not password and "password" in out.lower():
            return {"need_password": True}
    return {"ok": code == 0, "out": out.strip()}


def net_connect(b):
    args = ["nmcli", "dev", "wifi", "connect", str(b["ssid"])]
    if b.get("key"):
        args += ["password", str(b["key"])]
    return nm_maybe_root(args, b.get("password"))


# ---------------------------------------------------------------- som / brilho / energia
def audio_get():
    if not which("wpctl"):
        return {"available": False}
    code, out = run(["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"])
    m = re.search(r"([\d.]+)", out)
    if code or not m:
        return {"available": False}
    return {"available": True, "volume": round(float(m.group(1)) * 100), "muted": "MUTED" in out}


def audio_set(b):
    if b.get("volume") is not None:
        run(["wpctl", "set-volume", "-l", "1.0", "@DEFAULT_AUDIO_SINK@", f"{max(0, min(100, int(b['volume']))) / 100:.2f}"])
    if b.get("mute") is not None:
        run(["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "1" if b["mute"] else "0"])
    return audio_get()


def bright_get():
    if not which("brightnessctl"):
        return {"available": False}
    code, out = run(["brightnessctl", "-m", "-c", "backlight", "info"])
    if code or out.count(",") < 4:
        return {"available": False}
    return {"available": True, "percent": int(out.strip().split(",")[3].rstrip("%"))}


def bright_set(b):
    run(["brightnessctl", "-c", "backlight", "set", f"{max(1, min(100, int(b['percent'])))}%"])
    return bright_get()


def power(b):
    action = b.get("action")
    if action not in ("poweroff", "reboot", "suspend"):
        raise ValueError("ação inválida")
    code, out = run(["systemctl", action], 15)
    if code != 0:
        code, out = as_root(["systemctl", action], b.get("password"), 15)
        if code != 0 and not b.get("password") and "password" in out.lower():
            return {"need_password": True}
    return {"ok": code == 0, "out": out.strip()}


def auth(b):
    pw = str(b.get("password", ""))
    if CHKPWD is None:  # fora do Linux: modo de desenvolvimento
        ok = pw == os.environ.get("NEONOS_DEV_PASSWORD", "live")
    else:
        p = subprocess.run([CHKPWD, USER, "nonull"], input=(pw + "\0").encode(), capture_output=True, timeout=15)
        ok = p.returncode == 0
    if not ok:
        time.sleep(1)
    return {"ok": ok}


# ---------------------------------------------------------------- persistência (modo live)
def persist_status():
    return {"live": LIVE, "active": "/run/live/persistence" in (read("/proc/mounts", "") or "")}


def persist_setup(b):
    if not LIVE:
        raise ValueError("só funciona no modo live (pendrive)")
    return root_job("Persistência", ["bash", os.path.join(ROOT, "neon-persist.sh")], b.get("password"))


# ---------------------------------------------------------------- loja (apt) e programas
PKG_RE = re.compile(r"^[a-z0-9][a-z0-9+.\-]{1,80}$")


def store_status(pkgs):
    pkgs = [p for p in pkgs if PKG_RE.match(p)]
    if not pkgs or not which("dpkg-query"):
        return {p: False for p in pkgs}
    _, out = run(["dpkg-query", "-W", "-f=${Package}\t${db:Status-Abbrev}\n", *pkgs])
    inst = {l.split("\t")[0] for l in out.splitlines() if "\t" in l and l.split("\t")[1].startswith("ii")}
    return {p: p in inst for p in pkgs}


def store_search(q):
    if not which("apt-cache"):
        return {"available": False, "items": []}
    q = q.strip()
    if not q:
        return {"available": True, "items": []}
    _, out = run(["apt-cache", "search", "--names-only", q], 30)
    items = []
    for line in out.splitlines()[:60]:
        name, _, desc = line.partition(" - ")
        items.append({"name": name.strip(), "desc": desc.strip()})
    st = store_status([i["name"] for i in items])
    for i in items:
        i["installed"] = st.get(i["name"], False)
    return {"available": True, "items": items}


def store_action(b, action):
    pkg = str(b.get("pkg", ""))
    if action != "update" and not PKG_RE.match(pkg):
        raise ValueError("nome de pacote inválido")
    apt = ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get"]
    if action == "install":
        return root_job(f"Instalar {pkg}", [*apt, "install", "-y", pkg], b.get("password"))
    if action == "remove":
        return root_job(f"Remover {pkg}", [*apt, "remove", "-y", pkg], b.get("password"))
    return root_job("Atualizar índice", [*apt, "update"], b.get("password"))


APP_DIRS = ["/usr/share/applications", "/usr/local/share/applications", "/var/lib/flatpak/exports/share/applications",
            os.path.join(HOME, ".local/share/flatpak/exports/share/applications"), os.path.join(HOME, ".local/share/applications")]
NEON_HANDLERS = {"neonos-files.desktop": "files", "neonos-editor.desktop": "editor",
                 "neonos-viewer.desktop": "viewer", "neonos-player.desktop": "player"}
_apps = {"t": 0, "key": None, "all": []}


def parse_desktop(path):
    data, sect = {}, None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if line.startswith("["):
                sect = line
            elif sect == "[Desktop Entry]" and "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                data.setdefault(k.strip(), v.strip())
    if data.get("Type") != "Application" or "Exec" not in data or data.get("Hidden") == "true":
        return None
    te = data.get("TryExec")
    if te and not ((os.path.isabs(te) and os.access(te, os.X_OK)) or which(te)):
        return None
    only = [x for x in data.get("OnlyShowIn", "").split(";") if x]
    loc = lambda k: data.get(f"{k}[pt_BR]") or data.get(f"{k}[pt]") or data.get(k, "")
    return {"id": os.path.basename(path), "path": path, "name": loc("Name") or "?",
            "comment": loc("Comment") or loc("GenericName"), "exec": data["Exec"],
            "terminal": data.get("Terminal") == "true", "icon": data.get("Icon", ""),
            "mime": [m for m in data.get("MimeType", "").split(";") if m],
            "wmclass": data.get("StartupWMClass", ""), "categories": data.get("Categories", ""),
            "keywords": loc("Keywords"),
            "hidden": data.get("NoDisplay") == "true" or bool(only and not set(only) & {"labwc", "wlroots", "NeonOS"})}


def all_entries():
    key = tuple(safe(lambda d=d: os.stat(d).st_mtime, 0) for d in APP_DIRS)
    if key == _apps["key"] and time.time() - _apps["t"] < 120:
        return _apps["all"]
    apps = {}
    for d in APP_DIRS:
        for f in glob.glob(d + "/*.desktop"):
            e = safe(lambda f=f: parse_desktop(f))
            if e:
                apps[e["id"]] = e
            elif d.startswith(HOME):          # o usuário escondeu um app do sistema (Hidden=true)
                apps.pop(os.path.basename(f), None)
    _apps.update(t=time.time(), key=key, all=sorted(apps.values(), key=lambda a: a["name"].lower()))
    return _apps["all"]


def desktop_entries():
    return [{k: a[k] for k in ("id", "name", "comment", "exec", "terminal", "icon", "categories", "keywords")}
            for a in all_entries() if not a["hidden"]]


def entry(app_id):
    return next((a for a in all_entries() if a["id"] == app_id), None)


def exec_args(line, files=()):
    """Exec= do .desktop → argv, trocando %f/%u/%F/%U pelos arquivos (e @@ do Flatpak)."""
    out, used = [], False
    for t in shlex.split(line):
        if t in ("%f", "%u"):
            if files:
                out.append(files[0])
                used = True
        elif t in ("%F", "%U"):
            if files:
                out.extend(files)
                used = True
        elif t in ("@@", "@@u", "@@f"):
            if files:
                out.append(t)
        elif re.fullmatch(r"%[a-zA-Z]", t):
            continue
        else:
            out.append(t.replace("%%", "%"))
    if files and not used:
        out.extend(files)
    return out


def spawn(args, env=None):
    subprocess.Popen(args, cwd=HOME, start_new_session=True, env=env, stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def app_command(app_id, files=()):
    a = entry(app_id)
    if not a:
        raise ValueError("programa não encontrado")
    return a, exec_args(a["exec"], files)


def app_launch(b):
    a, args = app_command(b.get("id"))
    if a["terminal"]:
        return {"terminal": shlex.join(args)}
    spawn(args)
    return {"ok": True, "name": a["name"]}


def browser(b):
    if not IS_LINUX or not (which("firefox-esr") or which("firefox")):
        return {"available": False}
    url = str(b.get("url") or "")
    spawn(["bash", os.path.join(ROOT, "neon-browser.sh"), *([url] if url else [])])
    return {"ok": True}


def installer(b):
    if not LIVE:
        return {"ok": False, "error": "O NeonOS já está instalado neste disco."}
    if not which("calamares"):
        return {"ok": False, "error": "Instalador (calamares) não encontrado."}
    spawn(["sudo", "-n", "-E", "calamares"], env=dict(os.environ, QT_QPA_PLATFORM="wayland;xcb"))
    return {"ok": True}


# ---------------------------------------------------------------- atualizações
UPDATE_CONF = "/etc/neonos/update.conf"
NEON_UPDATE = "/usr/local/bin/neon-update"
BACKUPS = "/var/backups/neonos"
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def update_conf():
    conf = {"REPO": "", "BRANCH": "main"}
    for line in (read(UPDATE_CONF, "") or "").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            conf[k.strip()] = v.strip().strip('"')
    return conf


def apt_upgradable():
    if not which("apt"):
        return {"available": False, "items": [], "count": 0}
    _, out = run(["apt", "list", "--upgradable"], 60, env=dict(os.environ, LC_ALL="C"))
    items = []
    for line in out.splitlines():
        if "[upgradable from:" not in line:
            continue
        parts = line.split()
        items.append({"name": parts[0].split("/")[0], "new": parts[1] if len(parts) > 1 else "",
                      "old": line.split("[upgradable from:")[1].strip(" ]")})
    stamp = safe(lambda: os.path.getmtime("/var/lib/apt/lists"), 0)
    return {"available": True, "items": items, "count": len(items), "checked": int(stamp)}


def vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v)[:4]) or (0,)


def neon_check():
    conf = update_conf()
    res = {"version": VERSION, "repo": conf["REPO"], "branch": conf["BRANCH"], "remote": None, "newer": False,
           "installed": os.path.exists(NEON_UPDATE),
           "backups": sorted(os.listdir(BACKUPS), reverse=True) if os.path.isdir(BACKUPS) else []}
    if conf["REPO"]:
        import urllib.request
        try:
            url = f"https://raw.githubusercontent.com/{conf['REPO']}/{conf['BRANCH']}/neonos/VERSION"
            with urllib.request.urlopen(url, timeout=8) as r:
                res["remote"] = r.read(32).decode().strip()
            res["newer"] = vtuple(res["remote"]) > vtuple(VERSION)
        except Exception as e:
            res["error"] = f"não consegui verificar ({e.__class__.__name__})"
    return res


def neon_job(title, args, b):
    if not os.path.exists(NEON_UPDATE):
        raise ValueError("neon-update não está instalado neste sistema")
    return root_job(title, [NEON_UPDATE, *args], b.get("password"))


def neon_repo(b):
    repo, branch = str(b.get("repo", "")).strip(), str(b.get("branch") or "main").strip()
    if not REPO_RE.match(repo):
        raise ValueError("use o formato usuario/repositorio")
    if not os.path.exists(NEON_UPDATE):
        raise ValueError("neon-update não está instalado neste sistema")
    code, out = as_root([NEON_UPDATE, "--set-repo", repo, branch], b.get("password"), 15)
    if code != 0 and not b.get("password") and "password" in out.lower():
        return {"need_password": True}
    return {"ok": code == 0, "out": out.strip()}


def restart_self(b):
    """Reinicia o backend (depois de uma atualização da interface)."""
    def later():
        time.sleep(0.6)
        for p in (_idle.get("proc"), _night.get("proc")):
            if p and p.poll() is None:
                p.terminate()
        os.execv(sys.executable, [sys.executable, os.path.join(ROOT, "server.py")])
    threading.Thread(target=later, daemon=True).start()
    return {"ok": True}


# ---------------------------------------------------------------- monitores (neon-display)
NEON_DISPLAY = os.path.join(ROOT, "neon-display")
UI_EVENTS = {"display-menu", "start-menu", "files", "lock", "terminal", "tasks", "saver", "saver-off", "open"}


def displays():
    if not (IS_LINUX and which("wlr-randr") and os.environ.get("WAYLAND_DISPLAY")):
        return {"available": False}
    code, out = run([sys.executable, NEON_DISPLAY, "list"], 15)
    if code != 0:
        return {"available": False, "error": out.strip()[-200:]}
    return {"available": True, **json.loads(out)}


def restart_shell():
    """Fecha o Firefox da interface; o neonos-start.sh abre de novo já no tamanho dos monitores."""
    def later():
        time.sleep(0.8)
        run(["pkill", "-f", "--", "--name neonos-shell"])
    threading.Thread(target=later, daemon=True).start()


def display_mode(b):
    if not displays().get("available"):
        raise ValueError("controle de monitores indisponível neste sistema")
    code, out = run([sys.executable, NEON_DISPLAY, "mode", str(b.get("mode", ""))], 20)
    if code != 0:
        raise ValueError(out.strip()[-200:] or "falha ao mudar o modo")
    restart_shell()
    return {"ok": True, "mode": out.strip()}


def display_primary(b):
    name = str(b.get("name", ""))
    if not re.fullmatch(r"[\w.-]{1,40}", name):
        raise ValueError("nome de monitor inválido")
    code, out = run([sys.executable, NEON_DISPLAY, "primary", name], 20)
    if code != 0:
        raise ValueError(out.strip()[-200:] or "falha")
    restart_shell()
    return {"ok": True}


def display_arrange(b):
    order = [str(x) for x in (b.get("order") or [])]
    if not order or not all(re.fullmatch(r"[\w.-]{1,40}", n) for n in order):
        raise ValueError("ordem de monitores inválida")
    arr = b.get("arrange", "row") if b.get("arrange") in ("row", "column") else "row"
    align = b.get("align", "top") if b.get("align") in ("top", "center", "bottom") else "top"
    code, out = run([sys.executable, NEON_DISPLAY, "arrange", ",".join(order), arr, align], 20)
    if code != 0:
        raise ValueError(out.strip()[-200:] or "falha")
    restart_shell()
    return {"ok": True}


def ui_event(b):
    t = str(b.get("type", ""))
    if t == "shell":                      # Super+Espaço
        return {"ok": WM.raise_shell()}
    if t == "show-desktop":               # Super+D
        return {"ok": WM.toggle_desktop()}
    if t not in UI_EVENTS:
        raise ValueError("evento desconhecido")
    data = None
    if t == "open":
        path = P(b.get("path"))
        if not os.path.exists(path):
            raise ValueError("arquivo não encontrado")
        data = {"path": path, "app": b.get("app") if b.get("app") in ("files", "editor", "viewer", "player") else None}
    emit(t, "", "ui", data)
    return {"ok": True}


# ---------------------------------------------------------------- ícones dos apps
ICON_BASES = [os.path.join(HOME, ".local/share/icons"), os.path.join(HOME, ".local/share/flatpak/exports/share/icons"),
              "/var/lib/flatpak/exports/share/icons", "/usr/local/share/icons", "/usr/share/icons"]
ICON_THEMES = ("Papirus-Dark", "Papirus", "hicolor", "Adwaita", "breeze")
ICON_SUBS = ("scalable/apps", "64x64/apps", "128x128/apps", "48x48/apps", "96x96/apps", "256x256/apps",
             "512x512/apps", "32x32/apps")
NAME_RE = re.compile(r"^[\w.+-]{1,160}$")
_icons = {}


def icon_path(name):
    if not name:
        return None
    hit = _icons.get(name)
    if hit and (hit[0] or time.time() - hit[1] < 30):
        return hit[0]
    found = None
    if os.path.isabs(name):
        if os.path.isfile(name) and name.lower().endswith((".png", ".svg", ".jpg", ".jpeg", ".webp")):
            found = name
    elif NAME_RE.match(name):
        base = name[:-4] if name.lower().endswith((".png", ".svg")) else name
        cands = [f"{b}/{t}/{sub}/{base}{ext}" for b in ICON_BASES for t in ICON_THEMES for sub in ICON_SUBS
                 for ext in (".svg", ".png")]
        cands += [f"/usr/share/pixmaps/{base}{ext}" for ext in (".svg", ".png")]
        found = next((c for c in cands if os.path.isfile(c)), None)
    _icons[name] = (found, time.time())
    return found


_wcache = {}


def entry_for_window(app_id):
    """Acha o .desktop de uma janela pelo app_id (Wayland) ou WM_CLASS (X11)."""
    a = (app_id or "").lower()
    if not a:
        return None
    hit = _wcache.get(a)
    if hit and time.time() - hit[1] < 60:
        return hit[0]
    _wcache[a] = (_entry_for_window(a), time.time())
    return _wcache[a][0]


WM_ALIASES = {"neonos-browser": "firefox-esr.desktop", "org.mozilla.firefox": "firefox-esr.desktop"}


def _entry_for_window(a):
    if a in WM_ALIASES and entry(WM_ALIASES[a]):
        return entry(WM_ALIASES[a])
    ents = all_entries()
    tests = (lambda e: e["id"][:-8].lower() == a, lambda e: e["wmclass"].lower() == a,
             lambda e: e["id"][:-8].lower().split(".")[-1] == a,
             lambda e: os.path.basename(shlex.split(e["exec"])[0]).lower() == a,
             lambda e: e["name"].lower() == a)
    for t in tests:
        for e in ents:
            if safe(lambda: t(e)):
                return e
    return None


def icon_file(q):
    if q.get("name"):
        return icon_path(q["name"])
    if q.get("app"):
        e = entry(q["app"])
        return icon_path(e["icon"]) if e else None
    if q.get("wm"):
        e = entry_for_window(q["wm"])
        return (icon_path(e["icon"]) if e else None) or icon_path(q["wm"])
    fid = q.get("flatpak", "")
    if NAME_RE.match(fid):
        for base in (os.path.join(HOME, ".local/share/flatpak"), "/var/lib/flatpak"):
            for size in ("128x128", "64x64"):
                hit = glob.glob(f"{base}/appstream/*/*/active/icons/{size}/{fid}.png")
                if hit:
                    return hit[0]
        return icon_path(fid)
    return None


# ---------------------------------------------------------------- janelas dos apps nativos
def wm_list():
    snap = WM.snapshot()
    for w in snap["windows"]:
        e = entry_for_window(w["app_id"])
        w["name"] = e["name"] if e else (w["app_id"] or w["title"])
        w["icon"] = bool((e and icon_path(e["icon"])) or icon_path(w["app_id"]))
    return snap


def wm_action(b):
    hid, act = int(b.get("id", 0)), b.get("action")
    if hid not in WM.wins:
        raise ValueError("janela não encontrada")
    fn = {"toggle": WM.toggle, "activate": WM.activate, "minimize": WM.minimize, "close": WM.close,
          "maximize": lambda h: WM.maximize(h, True), "unmaximize": lambda h: WM.maximize(h, False)}.get(act)
    if not fn:
        raise ValueError("ação inválida")
    fn(hid)
    return {"ok": True}


def wm_guard(on):
    """Tela bloqueada: nenhum app nativo fica por cima e as notificações somem."""
    WM.guard = bool(on)
    if on:
        WM.raise_shell()
    if which("makoctl"):
        run(["makoctl", "mode", "-a" if on else "-r", "lock"], 5)
    return {"ok": True}


# ---------------------------------------------------------------- abrir arquivos (apps padrão)
MIMEAPPS = [os.path.join(HOME, ".config/mimeapps.list"), "/etc/xdg/mimeapps.list",
            os.path.join(HOME, ".local/share/applications/mimeapps.list"), "/usr/share/applications/mimeapps.list"]
TEXTLIKE = {"application/json", "application/xml", "application/x-shellscript", "application/javascript",
            "application/x-yaml", "application/toml", "application/x-desktop", "application/sql", "application/x-sh"}
DEFAULT_KINDS = {
    "web": ("Navegador", ["x-scheme-handler/https", "x-scheme-handler/http", "text/html"]),
    "video": ("Vídeos", ["video/mp4", "video/webm", "video/x-matroska", "video/quicktime", "video/x-msvideo"]),
    "music": ("Músicas", ["audio/mpeg", "audio/ogg", "audio/flac", "audio/x-wav", "audio/mp4"]),
    "image": ("Imagens", ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]),
    "pdf": ("PDF", ["application/pdf"]),
    "text": ("Textos", ["text/plain"]),
    "folder": ("Pastas", ["inode/directory"]),
    "mail": ("E-mail", ["x-scheme-handler/mailto"]),
}


def mime_of(path):
    if os.path.isdir(path):
        return "inode/directory"
    t = mimetypes.guess_type(path)[0]
    if not t and which("xdg-mime"):
        code, out = run(["xdg-mime", "query", "filetype", path], 5)
        t = out.strip().split(";")[0] if code == 0 and "/" in out else None
    return t or "application/octet-stream"


def _mimeapps(path):
    out, sect = {}, None
    for line in (read(path, "") or "").splitlines():
        line = line.strip()
        if line.startswith("["):
            sect = line
        elif "=" in line and sect:
            k, v = line.split("=", 1)
            out.setdefault(sect, {})[k.strip()] = [x for x in v.strip().split(";") if x]
    return out


def apps_for(mime):
    wanted = {mime, mime.split("/")[0] + "/*"}
    if mime.startswith("text/") or mime in TEXTLIKE:
        wanted.add("text/plain")
    res = [a for a in all_entries() if set(a["mime"]) & wanted]
    removed = set()
    for p in MIMEAPPS:
        m = _mimeapps(p)
        for app in m.get("[Added Associations]", {}).get(mime, []):
            e = entry(app)
            if e and e not in res:
                res.append(e)
        removed |= set(m.get("[Removed Associations]", {}).get(mime, []))
    res = [a for a in res if a["id"] not in removed]
    return sorted(res, key=lambda a: (a["id"] not in NEON_HANDLERS, a["hidden"], a["name"].lower()))


def default_app(mime):
    for p in MIMEAPPS:
        for app in _mimeapps(p).get("[Default Applications]", {}).get(mime, []):
            e = entry(app)
            if e:
                return e
    c = apps_for(mime)
    return c[0] if c else None


def set_default(mimes, app_id):
    if not entry(app_id):
        raise ValueError("programa não encontrado")
    path = MIMEAPPS[0]
    lines = (read(path, "") or "").splitlines()
    if "[Default Applications]" not in [l.strip() for l in lines]:
        lines += ["", "[Default Applications]"]
    for mime in mimes:
        i = next(i for i, l in enumerate(lines) if l.strip() == "[Default Applications]")
        j = i + 1
        while j < len(lines) and not lines[j].strip().startswith("["):
            if lines[j].split("=", 1)[0].strip() == mime:
                lines.pop(j)
                continue
            j += 1
        lines.insert(i + 1, f"{mime}={app_id};")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("\n".join(lines).strip() + "\n")


def _brief(a):
    return {"id": a["id"], "name": a["name"], "icon": bool(icon_path(a["icon"])), "neon": NEON_HANDLERS.get(a["id"])}


def open_info(q):
    path = P(q.get("path"))
    mime = mime_of(path)
    d = default_app(mime)
    return {"path": path, "mime": mime, "default": _brief(d) if d else None,
            "apps": [_brief(a) for a in apps_for(mime)][:40]}


def open_with(b):
    path = P(b.get("path"))
    if not os.path.exists(path):
        raise ValueError("arquivo não encontrado")
    app, mime = b.get("app"), mime_of(path)
    if app and b.get("remember"):
        set_default([mime], app)
    if not app:
        d = default_app(mime)
        if not d:
            return {"choose": True, "mime": mime}
        app = d["id"]
    if app in NEON_HANDLERS:
        return {"internal": NEON_HANDLERS[app], "path": path}
    a, args = app_command(app, [path])
    if a["terminal"]:
        return {"terminal": shlex.join(args)}
    spawn(args)
    return {"ok": True, "name": a["name"]}


def defaults_get():
    out = {}
    for k, (label, mimes) in DEFAULT_KINDS.items():
        d = default_app(mimes[0])
        out[k] = {"label": label, "current": d["id"] if d else None,
                  "apps": [{"id": a["id"], "name": a["name"]} for a in apps_for(mimes[0]) if not a["hidden"] or a["id"] in NEON_HANDLERS]}
    return {"kinds": out}


def defaults_set(b):
    kind = DEFAULT_KINDS.get(b.get("kind"))
    if not kind:
        raise ValueError("tipo inválido")
    set_default(kind[1], str(b.get("app", "")))
    return {"ok": True}


# ---------------------------------------------------------------- arquivos: lixeira, copiar/colar, compactar
TRASH = os.path.join(HOME, ".local/share/Trash")
ARCHIVE_RE = re.compile(r"\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|tzst|7z|rar|gz|bz2|xz|zst|iso|cab|jar)$", re.I)


def unique(dst):
    if not os.path.lexists(dst):
        return dst
    d, name = os.path.split(dst)
    m = re.match(r"^(.*?)(\.(?:tar\.)?[^./]{1,6})?$", name)
    stem, ext = (m.group(1), m.group(2) or "") if m and m.group(1) else (name, "")
    i = 2
    while os.path.lexists(os.path.join(d, f"{stem} ({i}){ext}")):
        i += 1
    return os.path.join(d, f"{stem} ({i}){ext}")


def tree_size(path, limit=None):
    if os.path.islink(path) or not os.path.isdir(path):
        return safe(lambda: os.lstat(path).st_size, 0)
    total, t0 = 0, time.time()
    for root, dirs, files in os.walk(path):
        for f in files:
            total += safe(lambda f=f: os.lstat(os.path.join(root, f)).st_size, 0)
        if limit and time.time() - t0 > limit:
            return -total
    return total


def trash_one(src):
    src = P(src)
    files, info = os.path.join(TRASH, "files"), os.path.join(TRASH, "info")
    if src == files or src.startswith(files + os.sep):        # já está na lixeira → apaga de vez
        delete_one(src)
        if os.path.dirname(src) == files:
            safe(lambda: os.remove(os.path.join(info, os.path.basename(src) + ".trashinfo")))
        return
    os.makedirs(files, exist_ok=True)
    os.makedirs(info, exist_ok=True)
    if safe(lambda: os.stat(src).st_dev) != safe(lambda: os.stat(files).st_dev) and which("gio"):
        if run(["gio", "trash", src], 60)[0] == 0:            # pendrive/outro disco: lixeira do próprio disco
            return
    dst = unique(os.path.join(files, os.path.basename(src.rstrip("/"))))
    with open(os.path.join(info, os.path.basename(dst) + ".trashinfo"), "w") as f:
        f.write(f"[Trash Info]\nPath={quote(src)}\nDeletionDate={time.strftime('%Y-%m-%dT%H:%M:%S')}\n")
    shutil.move(src, dst)


def delete_one(path):
    path = P(path)
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    else:
        os.remove(path)


def _paths(b):
    items = b.get("paths") or ([b["path"]] if b.get("path") else [])
    out = [P(x) for x in items if isinstance(x, str)]
    if not out:
        raise ValueError("nenhum item")
    return out


def fs_trash(b):
    for p in _paths(b):
        trash_one(p)
    return {"ok": True}


def fs_delete(b):
    for p in _paths(b):
        delete_one(p)
    return {"ok": True}


def trash_list():
    files, info = os.path.join(TRASH, "files"), os.path.join(TRASH, "info")
    items = []
    for e in safe(lambda: list(os.scandir(files)), []):
        meta = read(os.path.join(info, e.name + ".trashinfo"), "") or ""
        m = re.search(r"^Path=(.*)$", meta, re.M)
        items.append({"name": e.name, "from": unquote(m.group(1)) if m else ""})
    return items


def fs_restore(b):
    files, info = os.path.join(TRASH, "files"), os.path.join(TRASH, "info")
    done = 0
    for name in b.get("names") or []:
        name = os.path.basename(str(name))
        src = os.path.join(files, name)
        meta = read(os.path.join(info, name + ".trashinfo"), "") or ""
        m = re.search(r"^Path=(.*)$", meta, re.M)
        if not m or not os.path.lexists(src):
            continue
        dst = unique(unquote(m.group(1)))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
        safe(lambda: os.remove(os.path.join(info, name + ".trashinfo")))
        done += 1
    return {"ok": True, "restored": done}


def fs_empty_trash(b):
    for sub in ("files", "info"):
        d = os.path.join(TRASH, sub)
        for e in safe(lambda: list(os.scandir(d)), []):
            safe(lambda e=e: delete_one(e.path))
    if which("gio"):
        run(["gio", "trash", "--empty"], 60)
    return {"ok": True}


def fs_paste(b):
    items, dest, mode = _paths({"paths": b.get("items")}), P(b.get("dest")), b.get("mode", "copy")
    if not os.path.isdir(dest):
        raise ValueError("o destino não é uma pasta")
    for it in items:
        if os.path.isdir(it) and (dest == it or dest.startswith(it.rstrip("/") + os.sep)):
            raise ValueError(f"não dá para colocar a pasta \"{os.path.basename(it)}\" dentro dela mesma")

    def work(job):
        total = sum(tree_size(i) for i in items) or 1
        done = [0]

        def cp(src, dst):
            with open(src, "rb") as fi, open(dst, "wb") as fo:
                while True:
                    chunk = fi.read(1 << 20)
                    if not chunk:
                        break
                    fo.write(chunk)
                    done[0] += len(chunk)
                    job["progress"] = min(0.99, done[0] / total)
            shutil.copystat(src, dst)
            return dst

        for src in items:
            if mode == "move" and os.path.dirname(src) == dest:
                continue
            dst = unique(os.path.join(dest, os.path.basename(src.rstrip("/"))))
            job["log"] += os.path.basename(src) + "\n"
            if mode == "move":
                try:
                    os.rename(src, dst)
                    done[0] += tree_size(dst)
                    continue
                except OSError:
                    pass                                   # outro disco: copia e apaga
            if os.path.islink(src):
                os.symlink(os.readlink(src), dst)
            elif os.path.isdir(src):
                shutil.copytree(src, dst, symlinks=True, copy_function=cp)
            else:
                cp(src, dst)
            if mode == "move":
                delete_one(src)

    return py_job("Mover arquivos" if mode == "move" else "Copiar arquivos", work)


def fs_compress(b):
    items = _paths(b)
    name = os.path.basename(str(b.get("name") or "").strip()) or (
        os.path.basename(items[0]) if len(items) == 1 else "arquivos")
    dest = unique(os.path.join(os.path.dirname(items[0]), name if name.lower().endswith(".zip") else name + ".zip"))
    base = os.path.dirname(items[0])

    def work(job):
        files = []
        for it in items:
            if os.path.isdir(it) and not os.path.islink(it):
                for root, dirs, fs in os.walk(it):
                    files += [os.path.join(root, f) for f in fs]
                    if not fs and not dirs:
                        files.append(root)
            else:
                files.append(it)
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
            for i, f in enumerate(files):
                z.write(f, os.path.relpath(f, base))
                job["progress"] = (i + 1) / max(1, len(files))
        job["log"] += dest + "\n"

    return py_job("Compactar", work)


def fs_extract(b):
    src = P(b.get("path"))
    if not ARCHIVE_RE.search(src):
        raise ValueError("formato de arquivo compactado não reconhecido")
    stem = ARCHIVE_RE.sub("", os.path.basename(src)) or "extraido"
    dest = unique(os.path.join(os.path.dirname(src), stem))
    low = src.lower()
    if re.search(r"\.(gz|bz2|xz)$", low) and not re.search(r"\.(tar\.\w+|tgz|tbz2?|txz)$", low) and not tarfile.is_tarfile(src):
        def single(job):
            import bz2, gzip, lzma
            opener = {"gz": gzip.open, "bz2": bz2.open, "xz": lzma.open}[low.rsplit(".", 1)[1]]
            with opener(src, "rb") as fi, open(dest, "wb") as fo:
                shutil.copyfileobj(fi, fo)
            job["log"] += dest + "\n"
        return py_job("Extrair", single)

    def work(job):
        os.makedirs(dest)
        if zipfile.is_zipfile(src):
            with zipfile.ZipFile(src) as z:
                names = z.namelist()
                for i, n in enumerate(names):
                    z.extract(n, dest)
                    job["progress"] = (i + 1) / max(1, len(names))
        elif not re.search(r"\.(7z|rar|iso|cab)$", low) and tarfile.is_tarfile(src):
            with tarfile.open(src) as t:
                t.extractall(dest, filter="data")
        else:
            tool = which("7z") or which("7zz")
            if tool:
                code, out = run([tool, "x", "-y", f"-o{dest}", src], 3600)
            elif low.endswith(".rar") and which("unrar"):
                code, out = run(["unrar", "x", "-o+", src, dest + "/"], 3600)
            elif which("bsdtar"):
                code, out = run(["bsdtar", "-xf", src, "-C", dest], 3600)
            else:
                code, out = 1, "nenhum programa para esse formato (instale o 7zip)"
            if code != 0:
                raise ValueError(out.strip().splitlines()[-1] if out.strip() else "falha ao extrair")
        inner = os.listdir(dest)
        if len(inner) == 1 and os.path.isdir(os.path.join(dest, inner[0])):   # evita pasta/pasta
            tmp = dest + ".neon-tmp"
            os.rename(os.path.join(dest, inner[0]), tmp)
            os.rmdir(dest)
            os.rename(tmp, dest)
        job["log"] += dest + "\n"

    return py_job("Extrair", work)


def fs_info(q):
    path = P(q.get("path"))
    st = os.lstat(path)
    isdir = stat.S_ISDIR(st.st_mode)
    size = tree_size(path, limit=3) if isdir else st.st_size
    du = safe(lambda: shutil.disk_usage(path if isdir else os.path.dirname(path)))
    return {"path": path, "name": os.path.basename(path) or path, "dir": isdir, "mime": mime_of(path),
            "size": abs(size), "partial": size < 0,
            "count": safe(lambda: len(os.listdir(path)), 0) if isdir else None,
            "mtime": int(st.st_mtime), "mode": stat.filemode(st.st_mode),
            "owner": safe(lambda: pwd.getpwuid(st.st_uid).pw_name, str(st.st_uid)),
            "link": os.readlink(path) if os.path.islink(path) else None,
            "free": du.free if du else None, "total": du.total if du else None}


def fs_search(q):
    root, term, hidden = P(q.get("path")), str(q.get("q", "")).lower().strip(), q.get("hidden") == "1"
    if not term:
        return {"items": []}
    items, t0, stack = [], time.time(), [root]
    while stack and len(items) < 300 and time.time() - t0 < 4:
        d = stack.pop()
        for e in safe(lambda: list(os.scandir(d)), []):
            if not hidden and e.name.startswith("."):
                continue
            isdir = safe(lambda: e.is_dir(follow_symlinks=False), False)
            if term in e.name.lower():
                st = safe(lambda: e.stat(), None)
                items.append({"name": e.name, "dir": isdir, "path": e.path, "where": os.path.relpath(d, root),
                              "size": st.st_size if st else 0, "mtime": int(st.st_mtime) if st else 0})
            if isdir:
                stack.append(e.path)
    return {"items": items, "truncated": bool(stack)}


def fs_run(b):
    path = P(b.get("path"))
    if path.lower().endswith(".appimage"):
        os.chmod(path, os.stat(path).st_mode | 0o111)
        spawn([path])
        return {"ok": True}
    if path.lower().endswith(".sh"):
        return {"terminal": "bash " + shlex.quote(path)}
    if os.access(path, os.X_OK):
        spawn([path])
        return {"ok": True}
    raise ValueError("este arquivo não é um programa")


def fs_install_deb(b):
    path = P(b.get("path"))
    if not path.lower().endswith(".deb") or not os.path.isfile(path):
        raise ValueError("escolha um arquivo .deb")
    return root_job("Instalar " + os.path.basename(path),
                    ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", path], b.get("password"))


# ---------------------------------------------------------------- pendrives e outros discos
SYS_MOUNTS = ("/", "/boot", "/boot/efi", "/efi", "/home", "/usr", "/var", "[SWAP]")
_drives = {"known": None}


def drives():
    if not (IS_LINUX and which("lsblk")):
        return {"available": False, "drives": []}
    code, out = run(["lsblk", "-J", "-b", "-o", "NAME,PATH,LABEL,PARTLABEL,SIZE,FSTYPE,MOUNTPOINTS,RM,HOTPLUG,TYPE,PKNAME,MODEL,TRAN"], 10)
    if code != 0:
        return {"available": False, "drives": []}
    res, tree = [], json.loads(out).get("blockdevices", [])
    live = set()

    def find_live(devs, top=None):
        for d in devs:
            t = top or d
            if any(m and m.startswith(("/run/live", "/usr/lib/live", "/lib/live")) for m in (d.get("mountpoints") or [])):
                live.add(t.get("path"))
            find_live(d.get("children") or [], t)

    find_live(tree)

    def walk(devs, disk=None):
        for d in devs:
            kids = d.get("children") or []
            top = disk or d
            if top.get("path") in live:
                continue
            if kids:
                walk(kids, top)
                continue
            fs, mps = d.get("fstype"), [m for m in (d.get("mountpoints") or []) if m]
            if not fs or fs in ("swap", "LVM2_member", "crypto_LUKS", "squashfs"):
                continue
            if any(m in SYS_MOUNTS or m.startswith(("/run/live", "/usr/lib/live", "/lib/live")) for m in mps):
                continue
            label = d.get("label") or d.get("partlabel") or ""
            size = int(d.get("size") or 0)
            if label.lower() in ("persistence", "efi system partition", "microsoft reserved partition") or \
               (fs == "vfat" and size < 600 * 2**20 and not (d.get("rm") or d.get("hotplug"))):
                continue
            removable = bool(d.get("rm") or d.get("hotplug") or top.get("rm") or top.get("hotplug") or top.get("tran") == "usb")
            res.append({"dev": d["path"], "label": label, "size": size, "fstype": fs,
                        "mount": mps[0] if mps else None, "removable": removable,
                        "disk": top.get("path"), "model": (top.get("model") or "").strip()})

    walk(tree)
    return {"available": True, "drives": res}


def _dev(b):
    dev = str(b.get("dev", ""))
    if not re.fullmatch(r"/dev/[\w/-]{1,60}", dev) or not any(d["dev"] == dev for d in drives()["drives"]):
        raise ValueError("disco inválido")
    return dev


def drive_mount(b, interactive=True):
    dev = _dev(b)
    args = ["udisksctl", "mount", "-b", dev] + ([] if interactive else ["--no-user-interaction"])
    code, out = run(args, 120)
    m = re.search(r" at (/.+?)\.?$", out.strip())
    if code != 0 and "already mounted" not in out.lower():
        raise ValueError(out.strip().splitlines()[-1] if out.strip() else "não foi possível montar")
    path = m.group(1) if m else next((d["mount"] for d in drives()["drives"] if d["dev"] == dev), None)
    emit("drives", "", "ui")
    return {"ok": True, "path": path}


def drive_eject(b):
    dev = _dev(b)
    info = next(d for d in drives()["drives"] if d["dev"] == dev)
    for d in drives()["drives"]:
        if d["disk"] == info["disk"] and d["mount"]:
            code, out = run(["udisksctl", "unmount", "-b", d["dev"]], 60)
            if code != 0:
                raise ValueError("ainda está em uso: feche os arquivos abertos nele e tente de novo")
    if info["removable"] and info["disk"]:
        run(["udisksctl", "power-off", "-b", info["disk"]], 30)
    emit("drives", "", "ui")
    return {"ok": True}


def drive_check():
    cur = {d["dev"]: d for d in drives()["drives"] if d["removable"]}
    if _drives["known"] is not None:
        for dev, d in cur.items():
            if dev in _drives["known"]:
                continue
            name = d["label"] or d["model"] or "Pendrive"
            path = d["mount"]
            if not path:
                path = safe(lambda: drive_mount({"dev": dev}, interactive=False).get("path"))
            emit(f"{name} conectado", "Clique para abrir" if path else "Abra em Arquivos → Dispositivos", "ok",
                 {"open": path} if path else None)
        if set(cur) != set(_drives["known"]):
            emit("drives", "", "ui")
    _drives["known"] = cur


def drive_watch():
    """Pendrive conectado: monta sozinho e avisa (como no Windows). Acorda só com eventos do udev."""
    safe(drive_check)
    if which("udevadm"):
        p = subprocess.Popen(["udevadm", "monitor", "--udev", "--subsystem-match=block"],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        for line in p.stdout:
            if " add " in line or " remove " in line or " change " in line:
                time.sleep(1.5)                      # espera o disco terminar de aparecer
                safe(drive_check)
    while True:                                      # sem udev: confere de vez em quando
        time.sleep(5)
        safe(drive_check)


# ---------------------------------------------------------------- Flatpak (Flathub)
FLATHUB_FILE = "/usr/share/neonos/flathub.flatpakrepo"
FLATHUB_URL = "https://dl.flathub.org/repo/flathub.flatpakrepo"
FP_ID = re.compile(r"^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){2,}$")
_fp = {"ready": False, "appstream": 0}


def flatpak_ready():
    if _fp["ready"]:
        return True
    if not which("flatpak"):
        return False
    _, out = run(["flatpak", "remotes", "--user", "--columns=name"], 20)
    if "flathub" not in out.split():
        src = FLATHUB_FILE if os.path.exists(FLATHUB_FILE) else FLATHUB_URL
        if run(["flatpak", "remote-add", "--user", "--if-not-exists", "flathub", src], 90)[0] != 0:
            return False
    _fp["ready"] = True
    return True


def flatpak_appstream(force=False):
    stamp = glob.glob(os.path.join(HOME, ".local/share/flatpak/appstream/flathub/*/active/appstream.xml*"))
    age = time.time() - max((safe(lambda p=p: os.path.getmtime(p), 0) for p in stamp), default=0)
    if force or age > 86400:
        run(["nice", "-n", "19", "ionice", "-c", "3", "flatpak", "update", "--appstream", "--user", "flathub"], 600)
    return bool(stamp) or bool(glob.glob(os.path.join(HOME, ".local/share/flatpak/appstream/flathub/*/active/appstream.xml*")))


def _tsv(out, cols):
    rows = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= len(cols) - 1 and parts[0] not in ("Application ID", "Name", "Nome"):
            rows.append(dict(zip(cols, [p.strip() for p in parts])))
    return rows


def flatpak_installed():
    if not which("flatpak"):
        return []
    _, out = run(["flatpak", "list", "--app", "--columns=application,name,version,installation,size"], 30)
    return [r for r in _tsv(out, ("id", "name", "version", "scope", "size")) if FP_ID.match(r.get("id", ""))]


def flatpak_status():
    return {"available": bool(which("flatpak")), "installed": flatpak_installed()}


def flatpak_search(q):
    term = str(q.get("q", "")).strip()
    if not which("flatpak"):
        return {"available": False, "items": []}
    if not term:
        return {"available": True, "items": []}
    if not flatpak_ready() or not flatpak_appstream():
        return {"available": True, "items": [], "error": "Sem conexão com o Flathub agora. Verifique a internet."}
    _, out = run(["flatpak", "search", "--columns=application,name,description,version", term], 60)
    inst = {r["id"] for r in flatpak_installed()}
    items = [r for r in _tsv(out, ("id", "name", "desc", "version")) if FP_ID.match(r.get("id", ""))]
    seen, uniq = set(), []
    for r in items:
        if r["id"] not in seen:
            seen.add(r["id"])
            r["installed"] = r["id"] in inst
            uniq.append(r)
    return {"available": True, "items": uniq[:60]}


def flatpak_check(q):
    ids = [i for i in str(q.get("ids", "")).split(",") if FP_ID.match(i)]
    inst = {r["id"] for r in flatpak_installed()}
    return {"status": {i: i in inst for i in ids}}


def flatpak_install(b):
    fid = str(b.get("id", ""))
    if not FP_ID.match(fid):
        raise ValueError("identificador inválido")
    if not flatpak_ready():
        raise ValueError("não consegui acessar o Flathub (sem internet?)")
    return user_job("Instalar " + (b.get("name") or fid), ["flatpak", "install", "--user", "-y", "--noninteractive", "flathub", fid])


def flatpak_remove(b):
    fid = str(b.get("id", ""))
    if not FP_ID.match(fid):
        raise ValueError("identificador inválido")
    scope = next((r["scope"] for r in flatpak_installed() if r["id"] == fid), "user")
    if scope == "system":
        return root_job("Remover " + fid, ["flatpak", "uninstall", "--system", "-y", "--noninteractive", fid], b.get("password"))
    return user_job("Remover " + (b.get("name") or fid), ["flatpak", "uninstall", "--user", "-y", "--noninteractive", fid])


def flatpak_updates():
    if not which("flatpak"):
        return {"available": False, "items": [], "count": 0}
    items = []
    for scope in ("--user", "--system"):
        _, out = run(["flatpak", "remote-ls", "--updates", scope, "--columns=application,name"], 60)
        items += [r for r in _tsv(out, ("id", "name")) if FP_ID.match(r.get("id", ""))]
    return {"available": True, "items": items, "count": len(items)}


def flatpak_update(b):
    return user_job("Atualizar apps Flatpak", ["flatpak", "update", "--user", "-y", "--noninteractive"])


# ---------------------------------------------------------------- Bluetooth
MAC_RE = re.compile(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")
_bt = {"scan_until": 0}


def bt_status():
    if not (IS_LINUX and which("bluetoothctl")):
        return {"available": False, "reason": "Bluetooth não instalado"}
    code, out = run(["bluetoothctl", "show"], 6)
    if code != 0 or "Controller" not in out:
        return {"available": False, "reason": "Nenhum adaptador Bluetooth encontrado neste computador."}
    devices = []
    _, lst = run(["bluetoothctl", "devices"], 6)
    for line in lst.splitlines():
        m = re.match(r"Device (([0-9A-F]{2}:){5}[0-9A-F]{2}) (.*)", line.strip())
        if not m:
            continue
        _, info = run(["bluetoothctl", "info", m.group(1)], 6)
        g = lambda k: (re.search(rf"^\s*{k}: (.*)$", info, re.M) or [None, ""])[1].strip()
        bat = re.search(r"Battery Percentage: .*\((\d+)\)", info)
        devices.append({"mac": m.group(1), "name": g("Alias") or m.group(3), "paired": g("Paired") == "yes",
                        "connected": g("Connected") == "yes", "trusted": g("Trusted") == "yes",
                        "icon": g("Icon"), "battery": int(bat.group(1)) if bat else None})
    devices.sort(key=lambda d: (not d["connected"], not d["paired"], d["name"].lower()))
    return {"available": True, "powered": "Powered: yes" in out, "scanning": time.time() < _bt["scan_until"],
            "devices": devices}


def bt_power(b):
    on = bool(b.get("on"))
    if on and which("rfkill"):
        run(["rfkill", "unblock", "bluetooth"], 6)
    code, out = run(["bluetoothctl", "power", "on" if on else "off"], 10)
    if code != 0:
        raise ValueError(out.strip().splitlines()[-1] if out.strip() else "falhou")
    return {"ok": True}


def bt_scan(b):
    if time.time() < _bt["scan_until"]:
        return {"ok": True}
    _bt["scan_until"] = time.time() + 20
    threading.Thread(target=lambda: run(["bluetoothctl", "--timeout", "20", "scan", "on"], 30), daemon=True).start()
    return {"ok": True}


def bt_action(b):
    mac, act = str(b.get("mac", "")).upper(), b.get("action")
    if not MAC_RE.match(mac):
        raise ValueError("endereço inválido")
    if act == "connect":
        st = next((d for d in bt_status().get("devices", []) if d["mac"] == mac), None)
        if not st or not st["paired"]:
            code, out = run(["bluetoothctl", "--agent", "NoInputNoOutput", "pair", mac], 45)
            if code != 0 and "AlreadyExists" not in out:
                raise ValueError("não pareou — coloque o aparelho em modo de pareamento e tente de novo")
        run(["bluetoothctl", "trust", mac], 10)
        code, out = run(["bluetoothctl", "connect", mac], 30)
        if code != 0:
            raise ValueError("pareado, mas não conectou — tente de novo com o aparelho ligado e perto")
        return {"ok": True}
    cmd = {"disconnect": "disconnect", "remove": "remove"}.get(act)
    if not cmd:
        raise ValueError("ação inválida")
    code, out = run(["bluetoothctl", cmd, mac], 20)
    return {"ok": code == 0}


# ---------------------------------------------------------------- impressoras (CUPS)
def printers():
    if not which("lpstat"):
        return {"available": False, "printers": []}
    env = dict(os.environ, LC_ALL="C")
    _, out = run(["lpstat", "-p", "-d"], 10, env=env)
    default = (re.search(r"system default destination: (\S+)", out) or [None, None])[1]
    user_default = (re.search(r"^Default (\S+)", read(os.path.join(HOME, ".cups/lpoptions"), "") or "", re.M) or [None, None])[1]
    res = []
    for m in re.finditer(r"^printer (\S+) (.*)$", out, re.M):
        rest = m.group(2)
        state = "parada" if "disabled" in rest else "imprimindo" if "printing" in rest else "pronta"
        res.append({"name": m.group(1), "state": state, "default": m.group(1) == (user_default or default)})
    _, jobs = run(["lpstat", "-o"], 10, env=env)
    return {"available": True, "printers": res, "jobs": len([l for l in jobs.splitlines() if l.strip()])}


def printer_action(b):
    name, act = str(b.get("name", "")), b.get("action")
    if not re.fullmatch(r"[\w.@-]{1,127}", name):
        raise ValueError("nome inválido")
    if act == "test":
        page = next((p for p in ("/usr/share/cups/data/testprint", "/usr/share/cups/data/default-testpage.pdf") if os.path.exists(p)), None)
        if not page:
            raise ValueError("página de teste não encontrada")
        code, out = run(["lp", "-d", name, page], 20)
    elif act == "default":
        code, out = run(["lpoptions", "-d", name], 10)
    elif act == "cancel":
        code, out = run(["cancel", "-a", name], 10)
    elif act == "remove":
        code, out = run(["lpadmin", "-x", name], 15)
        if code != 0:
            code, out = as_root(["lpadmin", "-x", name], b.get("password"), 15)
            if code != 0 and not b.get("password"):
                return {"need_password": True}
    else:
        raise ValueError("ação inválida")
    if code != 0:
        raise ValueError(out.strip().splitlines()[-1] if out.strip() else "falhou")
    return {"ok": True}


# ---------------------------------------------------------------- energia: perfis, tela, suspensão, luz noturna
CONF_DIR = os.path.join(HOME, ".config/neonos")
POWER_CONF = os.path.join(CONF_DIR, "power.json")
_idle = {"proc": None}
_night = {"proc": None}


def jload(path, default):
    try:
        with open(path) as f:
            return {**default, **json.load(f)}
    except (OSError, ValueError):
        return dict(default)


def jsave(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f)


POWER_DEFAULT = {"saver": 0, "lock": 0, "screen_off": 15, "suspend": 0, "lock_on_suspend": True, "night": False, "night_temp": 4200}


def idle_apply():
    cfg = jload(POWER_CONF, POWER_DEFAULT)
    if "first" not in _idle:
        _idle["first"] = run(["pkill", "-u", str(os.getuid()), "-x", "swayidle"], 5)
    p = _idle["proc"]
    if p and p.poll() is None:
        p.terminate()
    _idle["proc"] = None
    if not (IS_LINUX and which("swayidle") and os.environ.get("WAYLAND_DISPLAY")):
        return False
    args = ["swayidle", "-w"]
    if cfg["saver"] > 0:
        args += ["timeout", str(int(cfg["saver"] * 60)), "neon-notify --ui saver", "resume", "neon-notify --ui saver-off"]
    if cfg["lock"] > 0:
        args += ["timeout", str(int(cfg["lock"] * 60)), "neon-notify --ui lock"]
    if cfg["screen_off"] > 0 and which("wlopm"):
        args += ["timeout", str(int(cfg["screen_off"] * 60)), "wlopm --off '*'", "resume", "wlopm --on '*'"]
    if cfg["suspend"] > 0:
        args += ["timeout", str(int(cfg["suspend"] * 60)), "systemctl suspend"]
    if cfg["lock_on_suspend"]:
        args += ["before-sleep", "neon-notify --ui lock"]
    if len(args) > 2:
        _idle["proc"] = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


def night_apply():
    cfg = jload(POWER_CONF, POWER_DEFAULT)
    if "first" not in _night:
        _night["first"] = run(["pkill", "-u", str(os.getuid()), "-x", "gammastep"], 5)
    p = _night["proc"]
    if p and p.poll() is None:
        p.terminate()
    _night["proc"] = None
    if cfg["night"] and which("gammastep") and os.environ.get("WAYLAND_DISPLAY"):
        _night["proc"] = subprocess.Popen(["gammastep", "-m", "wayland", "-P", "-O", str(int(cfg["night_temp"]))],
                                          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"ok": True, "night": bool(_night["proc"])}


def power_get():
    cfg = jload(POWER_CONF, POWER_DEFAULT)
    prof = None
    if which("powerprofilesctl"):
        code, out = run(["powerprofilesctl", "get"], 5)
        if code == 0:
            _, lst = run(["powerprofilesctl", "list"], 5)
            prof = {"current": out.strip(), "options": re.findall(r"^\*?\s*([\w-]+):\s*$", lst, re.M)}
    return {**cfg, "idle": bool(which("swayidle")) and IS_LINUX, "profiles": prof,
            "night_ok": bool(which("gammastep")), "night_on": bool(_night["proc"] and _night["proc"].poll() is None),
            "battery": safe(battery)}


def power_set(b):
    cfg = jload(POWER_CONF, POWER_DEFAULT)
    for k in ("saver", "lock", "screen_off", "suspend"):
        if k in b:
            cfg[k] = max(0, min(600, float(b[k])))
    for k in ("lock_on_suspend", "night"):
        if k in b:
            cfg[k] = bool(b[k])
    if "night_temp" in b:
        cfg["night_temp"] = max(2500, min(6500, int(b["night_temp"])))
    jsave(POWER_CONF, cfg)
    idle_apply()
    if "night" in b or "night_temp" in b:
        night_apply()
    if b.get("profile"):
        if not re.fullmatch(r"[\w-]{1,30}", b["profile"]):
            raise ValueError("perfil inválido")
        run(["powerprofilesctl", "set", b["profile"]], 10)
    return power_get()


# ---------------------------------------------------------------- região: fuso horário, relógio e teclado
KBD_ENV = os.path.join(HOME, ".config/labwc/environment.d/neonos-keyboard.env")
LAYOUTS = [("br", "", "Português (Brasil, ABNT2)"), ("us", "intl", "Inglês (EUA, internacional — com acentos)"),
           ("us", "", "Inglês (EUA)"), ("pt", "", "Português (Portugal)"), ("latam", "", "Espanhol (América Latina)"),
           ("es", "", "Espanhol (Espanha)"), ("gb", "", "Inglês (Reino Unido)"), ("fr", "", "Francês"),
           ("de", "", "Alemão"), ("it", "", "Italiano")]


def region_get():
    tz = ntp = None
    if which("timedatectl"):
        tz = run(["timedatectl", "show", "-p", "Timezone", "--value"], 5)[1].strip() or None
        ntp = run(["timedatectl", "show", "-p", "NTP", "--value"], 5)[1].strip() == "yes"
    env = read(KBD_ENV, "") or ""
    lay = (re.search(r"^XKB_DEFAULT_LAYOUT=(.*)$", env, re.M) or [None, "br"])[1]
    var = (re.search(r"^XKB_DEFAULT_VARIANT=(.*)$", env, re.M) or [None, ""])[1]
    return {"timezone": tz, "ntp": ntp, "layout": lay, "variant": var,
            "layouts": [{"layout": l, "variant": v, "name": n} for l, v, n in LAYOUTS]}


def timezones():
    code, out = run(["timedatectl", "list-timezones"], 10)
    return {"zones": out.split() if code == 0 else []}


def region_set(b):
    if "layout" in b:
        lay, var = str(b["layout"]), str(b.get("variant", ""))
        if (lay, var) not in [(l, v) for l, v, _ in LAYOUTS]:
            raise ValueError("layout inválido")
        os.makedirs(os.path.dirname(KBD_ENV), exist_ok=True)
        with open(KBD_ENV, "w") as f:
            f.write(f"XKB_DEFAULT_LAYOUT={lay}\nXKB_DEFAULT_VARIANT={var}\n")
        run(["labwc", "--reconfigure"], 10)
        return {"ok": True}
    if "timezone" in b:
        tz = str(b["timezone"])
        if not re.fullmatch(r"[A-Za-z0-9_+/-]{1,60}", tz) or tz not in timezones()["zones"]:
            raise ValueError("fuso horário inválido")
        code, out = as_root(["timedatectl", "set-timezone", tz], b.get("password"), 20)
    elif "ntp" in b:
        code, out = as_root(["timedatectl", "set-ntp", "true" if b["ntp"] else "false"], b.get("password"), 20)
    else:
        raise ValueError("nada para mudar")
    if code != 0:
        if not b.get("password"):
            return {"need_password": True}
        raise ValueError(out.strip().splitlines()[-1] if out.strip() else "falhou")
    return {"ok": True}


# ---------------------------------------------------------------- apps que abrem ao ligar
AUTOSTART = os.path.join(HOME, ".config/autostart")


def autostart_list():
    items = []
    for f in sorted(glob.glob(AUTOSTART + "/*.desktop")):
        txt = read(f, "") or ""
        g = lambda k: (re.search(rf"^{k}=(.*)$", txt, re.M) or [None, ""])[1].strip()
        items.append({"id": os.path.basename(f), "name": g("Name[pt_BR]") or g("Name") or os.path.basename(f),
                      "enabled": g("Hidden") != "true" and g("X-GNOME-Autostart-enabled") != "false"})
    return {"items": items}


def autostart_set(b):
    if b.get("add"):
        e = entry(str(b["add"]))
        if not e:
            raise ValueError("programa não encontrado")
        os.makedirs(AUTOSTART, exist_ok=True)
        shutil.copy(e["path"], os.path.join(AUTOSTART, e["id"]))
    elif b.get("remove"):
        f = os.path.join(AUTOSTART, os.path.basename(str(b["remove"])))
        if os.path.exists(f):
            os.remove(f)
    return autostart_list()


def autostart_run():
    """Abre os apps marcados para iniciar com o sistema (uma vez por sessão)."""
    flag = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "neonos-autostart.done")
    if os.path.exists(flag) or not os.environ.get("WAYLAND_DISPLAY"):
        return
    open(flag, "w").close()
    for f in sorted(glob.glob(AUTOSTART + "/*.desktop")):
        e = safe(lambda f=f: parse_desktop(f))
        txt = read(f, "") or ""
        if e and "X-GNOME-Autostart-enabled=false" not in txt:
            safe(lambda e=e: spawn(exec_args(e["exec"])))


# ---------------------------------------------------------------- drivers (placa de vídeo)
def drivers():
    gpus = []
    if which("lspci"):
        _, out = run(["lspci", "-nn"], 10)
        for line in out.splitlines():
            if re.search(r"VGA compatible|3D controller|Display controller", line):
                name = line.split(": ", 1)[-1]
                vendor = "nvidia" if "NVIDIA" in name else "amd" if re.search(r"AMD|ATI", name) else "intel" if "Intel" in name else "outro"
                gpus.append({"name": re.sub(r"\s*\[[0-9a-f]{4}:[0-9a-f]{4}\].*$", "", name), "vendor": vendor})
    has_nv = any(g["vendor"] == "nvidia" for g in gpus)
    pkg, note = "nvidia-driver", ""
    if has_nv and which("nvidia-detect"):
        _, out = run(["nvidia-detect"], 20)
        m = re.search(r"install the\s+(nvidia-[\w-]+)\s+package", out, re.S)
        if m:
            pkg = m.group(1)
        elif "not supported" in out.lower() or "no nvidia gpu" in out.lower():
            note = "Esta placa não é suportada pelo driver da NVIDIA do Debian; o driver livre (nouveau) continua sendo usado."
    st = store_status([pkg, "intel-microcode", "amd64-microcode"])
    sb = any(safe(lambda f=f: open(f, "rb").read()[-1:] == b"\x01", False)
             for f in glob.glob("/sys/firmware/efi/efivars/SecureBoot-*"))
    return {"gpus": gpus, "nvidia": has_nv, "package": pkg, "installed": st.get(pkg, False), "note": note,
            "loaded": os.path.exists("/proc/driver/nvidia/version"), "secure_boot": sb, "live": LIVE,
            "microcode": st.get("intel-microcode") or st.get("amd64-microcode")}


def driver_action(b):
    d = drivers()
    if not d["nvidia"]:
        raise ValueError("nenhuma placa NVIDIA encontrada")
    if not re.fullmatch(r"nvidia-[\w-]{1,40}", d["package"]):
        raise ValueError("pacote inválido")
    if b.get("action") == "remove":
        script = ("set -e; DEBIAN_FRONTEND=noninteractive apt-get purge -y 'nvidia-*' 'libnvidia-*' || true; "
                  "rm -f /etc/modprobe.d/neonos-nvidia.conf; update-initramfs -u")
        return root_job("Remover driver NVIDIA", ["bash", "-c", script], b.get("password"))
    script = ("set -e; apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y linux-headers-amd64 "
              f"{d['package']} firmware-misc-nonfree; "
              "echo 'options nvidia-drm modeset=1 fbdev=1' > /etc/modprobe.d/neonos-nvidia.conf; update-initramfs -u")
    return root_job("Instalar driver NVIDIA", ["bash", "-c", script], b.get("password"))


# ---------------------------------------------------------------- segurança: firewall e senha
def firewall_get():
    conf = read("/etc/ufw/ufw.conf", None)
    return {"available": conf is not None and bool(which("ufw") or os.path.exists("/usr/sbin/ufw")),
            "enabled": bool(conf and re.search(r"^ENABLED=yes", conf, re.M))}


def firewall_set(b):
    code, out = as_root(["ufw", "--force", "enable" if b.get("on") else "disable"], b.get("password"), 30)
    if code != 0:
        if not b.get("password"):
            return {"need_password": True}
        raise ValueError(out.strip().splitlines()[-1] if out.strip() else "falhou")
    return firewall_get()


def change_password(b):
    cur, new = str(b.get("current", "")), str(b.get("new", ""))
    if len(new) < 4:
        raise ValueError("a senha nova precisa de pelo menos 4 caracteres")
    if "\n" in new or ":" in new:
        raise ValueError("a senha não pode ter quebra de linha nem ':'")
    if not auth({"password": cur})["ok"]:
        raise ValueError("a senha atual está errada")
    env = dict(os.environ, LC_ALL="C")
    code, out = run(["sudo", "-S", "-p", "", "chpasswd"], 20, input=f"{cur}\n{USER}:{new}\n", env=env)
    if code != 0:
        raise ValueError(out.strip().splitlines()[-1] if out.strip() else "não foi possível trocar a senha")
    return {"ok": True}


# ---------------------------------------------------------------- gerenciador de tarefas
_cpu_prev = {}


def procs_all():
    clk, now, ncpu = os.sysconf("SC_CLK_TCK"), time.time(), os.cpu_count() or 1
    page = os.sysconf("SC_PAGE_SIZE")
    me, out, seen = os.getuid(), [], {}
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            with open(f"/proc/{pid}/stat") as f:
                raw = f.read()
            name = raw[raw.index("(") + 1: raw.rindex(")")]
            fields = raw[raw.rindex(")") + 2:].split()
            ticks, rss = int(fields[11]) + int(fields[12]), int(fields[21]) * page
            uid = os.stat(f"/proc/{pid}").st_uid
            cmd = (read(f"/proc/{pid}/cmdline", "") or "").replace("\0", " ").strip()
        except (OSError, ValueError, IndexError):
            continue
        prev = _cpu_prev.get(pid)
        cpu = 0.0
        if prev and now > prev[1]:
            cpu = max(0.0, (ticks - prev[0]) / clk / (now - prev[1]) * 100 / ncpu)
        seen[pid] = (ticks, now)
        out.append({"pid": int(pid), "name": name, "cpu": round(cpu, 1), "mem": rss, "mine": uid == me,
                    "user": safe(lambda: pwd.getpwuid(uid).pw_name, str(uid)), "cmd": cmd[:200]})
    _cpu_prev.clear()
    _cpu_prev.update(seen)
    mem = safe(meminfo, (0, 0))
    return {"procs": out, "cpu": safe(cpu_percent, 0), "mem_used": mem[0], "mem_total": mem[1], "cores": ncpu}


def proc_kill(b):
    pid = int(b.get("pid", 0))
    if pid <= 1 or os.stat(f"/proc/{pid}").st_uid != os.getuid():
        raise ValueError("só dá para finalizar programas do seu usuário")
    if pid == os.getpid():
        raise ValueError("esse é o próprio NeonOS")
    os.kill(pid, signal.SIGKILL if b.get("force") else signal.SIGTERM)
    return {"ok": True}


def hardware():
    cpu = (re.search(r"^model name\s*:\s*(.*)$", read("/proc/cpuinfo", "") or "", re.M) or [None, platform.processor()])[1]
    mem = safe(meminfo, (0, 0))
    du = safe(lambda: shutil.disk_usage("/"))
    vendor = read("/sys/class/dmi/id/sys_vendor", "") or ""
    product = read("/sys/class/dmi/id/product_name", "") or ""
    board = " ".join(x for x in (read("/sys/class/dmi/id/board_vendor", ""), read("/sys/class/dmi/id/board_name", "")) if x)
    return {"cpu": cpu, "cores": os.cpu_count(), "mem_total": mem[1],
            "gpus": [g["name"] for g in drivers()["gpus"]] if which("lspci") else [],
            "disk": {"used": du.used, "total": du.total} if du else None,
            "machine": " ".join(x for x in (vendor, product) if x and "O.E.M" not in x and "To Be Filled" not in x) or board}


# ---------------------------------------------------------------- ferramentas do sistema (apps nativos)
TOOLS = {"printers": "system-config-printer", "bluetooth": "blueman-manager", "network": "nm-connection-editor",
         "backup": "timeshift-launcher", "disks": "gnome-disks", "sound": "pavucontrol", "partitions": "gparted",
         "scanner": "simple-scan", "calculator": "gnome-calculator"}


def dnd_set(b):
    if which("makoctl"):
        run(["makoctl", "mode", "-a" if b.get("on") else "-r", "do-not-disturb"], 5)
    return {"ok": True}


def screenshot(b):
    """Captura de tela pelo menu (espera o menu fechar antes)."""
    tool = os.path.join(ROOT, "neon-shot")
    threading.Timer(0.45, lambda: spawn([tool, "area" if b.get("area") else "tela"])).start()
    return {"ok": True}


PROTECTED = {"firefox-esr", "labwc", "python3", "network-manager", "pipewire", "wireplumber", "xwayland", "plymouth",
             "calamares", "flatpak", "sudo", "systemd", "bash"}


def app_uninstall(b):
    e = entry(str(b.get("id", "")))
    if not e:
        raise ValueError("programa não encontrado")
    if "/flatpak/exports/" in e["path"]:
        return flatpak_remove({"id": e["id"][:-8], "name": e["name"], "password": b.get("password")})
    code, out = run(["dpkg", "-S", e["path"]], 15)
    pkg = out.split(":")[0].strip() if code == 0 else ""
    if not PKG_RE.match(pkg):
        raise ValueError("não descobri de qual pacote é este app")
    if pkg in PROTECTED:
        raise ValueError(f"{e['name']} faz parte do NeonOS e não pode ser removido")
    return root_job(f"Desinstalar {e['name']}", ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "remove", "-y", pkg],
                    b.get("password"))


def tool_launch(b):
    cmd = TOOLS.get(b.get("tool"))
    if not cmd:
        raise ValueError("ferramenta desconhecida")
    if not which(cmd):
        raise ValueError(f"{cmd} não está instalado")
    spawn([cmd])
    return {"ok": True}


# ---------------------------------------------------------------- HTTP
GET = {
    "/api/displays": lambda q: displays(),
    "/api/ping": lambda q: SYS,
    "/api/stats": lambda q: stats(),
    "/api/events": lambda q: events_since(int(q.get("since", 0)), int(q.get("wm", -1)), q.get("wait") == "1"),
    "/api/wm": lambda q: wm_list(),
    "/api/open/info": open_info,
    "/api/defaults": lambda q: defaults_get(),
    "/api/fs/info": fs_info,
    "/api/fs/search": fs_search,
    "/api/trash": lambda q: {"items": trash_list()},
    "/api/drives": lambda q: drives(),
    "/api/flatpak": lambda q: flatpak_status(),
    "/api/flatpak/search": flatpak_search,
    "/api/flatpak/check": flatpak_check,
    "/api/flatpak/updates": lambda q: flatpak_updates(),
    "/api/bt": lambda q: bt_status(),
    "/api/printers": lambda q: printers(),
    "/api/power/settings": lambda q: power_get(),
    "/api/region": lambda q: region_get(),
    "/api/region/zones": lambda q: timezones(),
    "/api/autostart": lambda q: autostart_list(),
    "/api/drivers": lambda q: drivers(),
    "/api/firewall": lambda q: firewall_get(),
    "/api/procs": lambda q: procs_all(),
    "/api/hardware": lambda q: hardware(),
    "/api/fs/list": lambda q: fs_list(q.get("path"), q.get("hidden") == "1"),
    "/api/fs/read": lambda q: fs_read(q.get("path")),
    "/api/media/scan": lambda q: media_scan(q.get("path")),
    "/api/pty/read": lambda q: pty_read(q.get("id")),
    "/api/net": lambda q: net_status(q.get("quick") == "1"),
    "/api/audio": lambda q: audio_get(),
    "/api/brightness": lambda q: bright_get(),
    "/api/persist": lambda q: persist_status(),
    "/api/store/search": lambda q: store_search(q.get("q", "")),
    "/api/store/status": lambda q: {"status": store_status(q.get("pkgs", "").split(","))},
    "/api/apps": lambda q: {"apps": [dict(a, icon=bool(icon_path(a["icon"]))) for a in desktop_entries()]},
    "/api/jobs": lambda q: JOBS.get(q.get("id")) or {"error": "tarefa não encontrada"},
    "/api/updates": lambda q: apt_upgradable(),
    "/api/neon/check": lambda q: neon_check(),
}
POST = {
    "/api/fs/write": fs_write,
    "/api/fs/mkdir": fs_mkdir,
    "/api/fs/touch": fs_touch,
    "/api/fs/rename": fs_rename,
    "/api/fs/trash": fs_trash,
    "/api/pty/new": pty_new,
    "/api/pty/write": lambda b: pty_call(b, lambda p: p.write(str(b.get("data", "")))),
    "/api/pty/resize": lambda b: pty_call(b, lambda p: p.resize(b.get("cols", 80), b.get("rows", 24))),
    "/api/pty/close": pty_close,
    "/api/net/connect": net_connect,
    "/api/net/radio": lambda b: nm_maybe_root(["nmcli", "radio", "wifi", "on" if b.get("on") else "off"], b.get("password"), 15),
    "/api/net/rescan": lambda b: {"ok": run(["nmcli", "dev", "wifi", "rescan"])[0] == 0},
    "/api/audio": audio_set,
    "/api/brightness": bright_set,
    "/api/power": power,
    "/api/auth": auth,
    "/api/notify": lambda b: (emit(b.get("title", "NeonOS"), b.get("body", ""), b.get("kind", "info"),
                                   {"open": P(b["open"])} if b.get("open") else None), {"ok": True})[1],
    "/api/persist/setup": persist_setup,
    "/api/store/install": lambda b: store_action(b, "install"),
    "/api/store/remove": lambda b: store_action(b, "remove"),
    "/api/store/update": lambda b: store_action(b, "update"),
    "/api/apps/launch": app_launch,
    "/api/browser": browser,
    "/api/installer": installer,
    "/api/updates/refresh": lambda b: root_job("Procurar atualizações", ["env", "LC_ALL=C", "apt-get", "update"], b.get("password")),
    "/api/updates/upgrade": lambda b: root_job("Atualizar o sistema", [
        "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "-y", "-o", "Dpkg::Options::=--force-confdef",
        "-o", "Dpkg::Options::=--force-confold", "full-upgrade"], b.get("password")),
    "/api/neon/update": lambda b: neon_job("Atualizar o NeonOS", ["--force"] if b.get("force") else [], b),
    "/api/neon/rollback": lambda b: neon_job("Voltar versão do NeonOS", ["--rollback"], b),
    "/api/neon/repo": neon_repo,
    "/api/neon/restart": restart_self,
    "/api/displays/mode": display_mode,
    "/api/displays/primary": display_primary,
    "/api/displays/arrange": display_arrange,
    "/api/ui": ui_event,
    "/api/wm": wm_action,
    "/api/wm/shell": lambda b: {"ok": WM.raise_shell(bool(b.get("temp")))},
    "/api/wm/restore": lambda b: {"ok": WM.restore()},
    "/api/wm/desktop": lambda b: {"ok": WM.toggle_desktop()},
    "/api/wm/guard": lambda b: wm_guard(b.get("on")),
    "/api/open": open_with,
    "/api/defaults": defaults_set,
    "/api/fs/delete": fs_delete,
    "/api/fs/restore": fs_restore,
    "/api/fs/empty-trash": fs_empty_trash,
    "/api/fs/paste": fs_paste,
    "/api/fs/compress": fs_compress,
    "/api/fs/extract": fs_extract,
    "/api/fs/run": fs_run,
    "/api/fs/install-deb": fs_install_deb,
    "/api/drives/mount": drive_mount,
    "/api/drives/eject": drive_eject,
    "/api/flatpak/install": flatpak_install,
    "/api/flatpak/remove": flatpak_remove,
    "/api/flatpak/update": flatpak_update,
    "/api/bt/power": bt_power,
    "/api/bt/scan": bt_scan,
    "/api/bt/action": bt_action,
    "/api/printers/action": printer_action,
    "/api/power/settings": power_set,
    "/api/region": region_set,
    "/api/autostart": autostart_set,
    "/api/drivers": driver_action,
    "/api/firewall": firewall_set,
    "/api/account/password": change_password,
    "/api/procs/kill": proc_kill,
    "/api/tool": tool_launch,
    "/api/apps/uninstall": app_uninstall,
    "/api/dnd": dnd_set,
    "/api/screenshot": screenshot,
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "max-age=600" if getattr(self, "_cache", False) else "no-store")
        super().end_headers()

    def _json(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _trusted(self):  # bloqueia DNS rebinding e chamadas de outros sites
        if self.headers.get("Host") not in ALLOWED_HOSTS:
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin.split("//", 1)[-1] in ALLOWED_HOSTS

    def _send_file(self, path):
        path = P(path)
        size = os.path.getsize(path)
        start, end, status = 0, size - 1, 200
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if m and size:
            s, e = m.groups()
            if s:
                start, end = int(s), min(int(e), size - 1) if e else size - 1
            elif e:
                start = max(0, size - int(e))
            status = 206
        length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            while length > 0:
                chunk = f.read(min(65536, length))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                length -= len(chunk)

    def _dispatch(self, routes, arg):
        u = urlparse(self.path)
        if not self._trusted():
            return self._json({"error": "forbidden"}, 403)
        try:
            if u.path == "/api/fs/raw":
                return self._send_file(arg.get("path"))
            if u.path == "/api/icon":
                p = icon_file(arg)
                if not p:
                    return self._json({"error": "sem ícone"}, 404)
                self._cache = True
                return self._send_file(p)
            fn = routes.get(u.path)
            if not fn:
                return self._json({"error": "not found"}, 404)
            self._json(fn(arg))
        except (OSError, ValueError, KeyError, TypeError) as e:
            self._json({"error": str(e)}, 400)

    def do_GET(self):
        self._cache = False
        u = urlparse(self.path)
        if not u.path.startswith("/api/"):
            return super().do_GET()
        self._dispatch(GET, {k: v[0] for k, v in parse_qs(u.query).items()})

    def do_POST(self):
        self._cache = False
        if self.headers.get("Content-Type") != "application/json":
            return self._json({"error": "forbidden"}, 403)
        n = int(self.headers.get("Content-Length", 0) or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        except ValueError:
            return self._json({"error": "json inválido"}, 400)
        self._dispatch(POST, body if isinstance(body, dict) else {})


def background_start():
    if IS_LINUX and os.environ.get("WAYLAND_DISPLAY"):
        SYS["wm"] = WM.start()
        SYS["idle"] = bool(safe(idle_apply, False))
        safe(night_apply)
        threading.Timer(4, autostart_run).start()
    if IS_LINUX:
        threading.Thread(target=drive_watch, daemon=True).start()
    if which("flatpak"):
        threading.Timer(600, lambda: safe(lambda: flatpak_ready() and flatpak_appstream())).start()


if __name__ == "__main__":
    print(f"NeonOS em http://127.0.0.1:{PORT}")
    background_start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
