#!/usr/bin/env python3
"""NeonOS backend — serve a interface e faz a ponte com o Linux.

Escuta só em 127.0.0.1 e roda como o usuário logado. Tarefas de root
(instalar programas, persistência, rede) passam por sudo com a senha do usuário.
"""
import codecs, fcntl, glob, json, mimetypes, os, platform, pty, pwd, re, select, shlex, shutil
import signal, struct, subprocess, sys, termios, threading, time, uuid
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
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
    if password:
        return run(["sudo", "-S", "-p", "", *args], timeout, input=password + "\n")
    return run(["sudo", "-n", *args], timeout)


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
_ev_lock = threading.Lock()


def emit(title, body="", kind="info"):
    with _ev_lock:
        _ev["seq"] += 1
        EVENTS.append({"id": _ev["seq"], "title": str(title)[:120], "body": str(body)[:300], "kind": kind})
        del EVENTS[:-50]


def events_since(since):
    return {"events": [e for e in EVENTS if e["id"] > since], "last": _ev["seq"]}


JOBS = {}


def start_job(title, args, password=None):
    jid = uuid.uuid4().hex[:8]
    job = JOBS[jid] = {"id": jid, "title": title, "log": "", "done": False, "code": None}

    def worker():
        cmd = args
        if not IS_ROOT:
            cmd = ["sudo", "-S", "-p", "", *args] if password else ["sudo", "-n", *args]
        try:
            p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, bufsize=1)
            if password:
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
        items.append({"name": e.name, "dir": isdir, "size": st.st_size, "mtime": int(st.st_mtime)})
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


def fs_trash(b):
    src = P(b["path"])
    trash = os.path.join(HOME, ".local/share/Trash/files")
    os.makedirs(trash, exist_ok=True)
    if src.startswith(trash + os.sep):  # já está na lixeira → apaga de vez
        shutil.rmtree(src) if os.path.isdir(src) and not os.path.islink(src) else os.remove(src)
        return {"ok": True, "deleted": True}
    dst = os.path.join(trash, os.path.basename(src))
    if os.path.exists(dst):
        dst += time.strftime(".%Y%m%d-%H%M%S")
    shutil.move(src, dst)
    return {"ok": True}


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


def parse_desktop(path):
    data, sect = {}, None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if line.startswith("["):
                sect = line
            elif sect == "[Desktop Entry]" and "=" in line:
                k, v = line.split("=", 1)
                data[k.strip()] = v.strip()
    if data.get("Type") != "Application" or "Exec" not in data:
        return None
    if data.get("NoDisplay") == "true" or data.get("Hidden") == "true":
        return None
    return {"id": os.path.basename(path),
            "name": data.get("Name[pt_BR]") or data.get("Name[pt]") or data.get("Name", "?"),
            "comment": data.get("Comment[pt_BR]") or data.get("Comment", ""),
            "exec": data["Exec"], "terminal": data.get("Terminal") == "true"}


def desktop_entries():
    apps = {}
    for d in ("/usr/share/applications", "/usr/local/share/applications", os.path.join(HOME, ".local/share/applications")):
        for f in glob.glob(d + "/*.desktop"):
            e = safe(lambda: parse_desktop(f))
            if e:
                apps[e["id"]] = e
    return sorted(apps.values(), key=lambda a: a["name"].lower())


def spawn(args, env=None):
    subprocess.Popen(args, cwd=HOME, start_new_session=True, env=env, stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def app_command(app_id):
    a = next((x for x in desktop_entries() if x["id"] == app_id), None)
    if not a:
        raise ValueError("programa não encontrado")
    return a, [t for t in shlex.split(a["exec"]) if not re.fullmatch(r"%[a-zA-Z]", t)]


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
        os.execv(sys.executable, [sys.executable, os.path.join(ROOT, "server.py")])
    threading.Thread(target=later, daemon=True).start()
    return {"ok": True}


# ---------------------------------------------------------------- HTTP
GET = {
    "/api/ping": lambda q: SYS,
    "/api/stats": lambda q: stats(),
    "/api/events": lambda q: events_since(int(q.get("since", 0))),
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
    "/api/apps": lambda q: {"apps": desktop_entries()},
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
    "/api/notify": lambda b: (emit(b.get("title", "NeonOS"), b.get("body", ""), b.get("kind", "info")), {"ok": True})[1],
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
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
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
            fn = routes.get(u.path)
            if not fn:
                return self._json({"error": "not found"}, 404)
            self._json(fn(arg))
        except (OSError, ValueError, KeyError, TypeError) as e:
            self._json({"error": str(e)}, 400)

    def do_GET(self):
        u = urlparse(self.path)
        if not u.path.startswith("/api/"):
            return super().do_GET()
        self._dispatch(GET, {k: v[0] for k, v in parse_qs(u.query).items()})

    def do_POST(self):
        if self.headers.get("Content-Type") != "application/json":
            return self._json({"error": "forbidden"}, 403)
        n = int(self.headers.get("Content-Length", 0) or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        except ValueError:
            return self._json({"error": "json inválido"}, 400)
        self._dispatch(POST, body if isinstance(body, dict) else {})


if __name__ == "__main__":
    print(f"NeonOS em http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
