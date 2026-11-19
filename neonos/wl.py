"""Cliente Wayland mínimo, sem bibliotecas: lista e controla as janelas dos apps nativos
(Steam, LibreOffice, apps Flatpak...) pelo protocolo wlr-foreign-toplevel-management,
que o labwc oferece. É assim que a barra de tarefas do NeonOS mostra essas janelas.

Também controla a "camada" da interface: ela é uma janela comum do Firefox, então para
aparecer por cima dos apps nativos (menu iniciar, janelas do NeonOS, bloqueio) pedimos ao
compositor para ativá-la; e para não esconder os apps ao clicar na área de trabalho, o
rc.xml só dá foco (sem trazer para frente) quando o clique é na interface.
"""
import os, socket, struct, threading, time

_ST_MAX, _ST_MIN, _ST_ACTIVE, _ST_FULL = 0, 1, 2, 3


def _str(s):
    b = s.encode() + b"\0"
    return struct.pack("<I", len(b)) + b + b"\0" * (-len(b) % 4)


def _u32(b, o):
    return struct.unpack_from("<I", b, o)[0], o + 4


def _s(b, o):
    n, o = _u32(b, o)
    return (b[o:o + n - 1].decode("utf-8", "replace") if n else ""), o + n + (-n % 4)


def _arr(b, o):
    n, o = _u32(b, o)
    return b[o:o + n], o + n + (-n % 4)


class Toplevels:
    def __init__(self, shell_id="neonos-shell", on_change=None):
        self.shell_id = shell_id
        self.on_change = on_change or (lambda: None)
        self.ok = False
        self.sock = None
        self.ifaces = {1: "wl_display"}
        self.next_id = 2
        self.seat = self.mgr = None
        self.wins, self.pending = {}, {}
        self.slock, self.dlock = threading.Lock(), threading.Lock()
        self.seq = 0             # muda a cada alteração (a barra de tarefas usa para se atualizar)
        self.tick = 0            # relógio lógico de ativações (≈ ordem de empilhamento)
        self.shell_raised = 0    # tick da última vez que a interface veio para frente
        self.saved = []          # apps que estavam por cima antes de um "levantar temporário"
        self.desk_hidden = []    # apps minimizados pelo "mostrar área de trabalho"
        self.guard = False       # tela bloqueada: nenhum app nativo pode ficar por cima

    # ------------------------------------------------------------ conexão
    def start(self):
        disp = os.environ.get("WAYLAND_DISPLAY")
        if not disp:
            return False
        path = disp if disp.startswith("/") else os.path.join(
            os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), disp)
        try:
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.connect(path)
        except OSError:
            return False
        reg = self._new("wl_registry")
        self._send(1, 1, struct.pack("<I", reg))          # wl_display.get_registry
        threading.Thread(target=self._loop, daemon=True).start()
        for _ in range(100):
            if self.ok:
                break
            time.sleep(0.02)
        return self.ok

    def _new(self, iface):
        i = self.next_id
        self.next_id += 1
        self.ifaces[i] = iface
        return i

    def _send(self, obj, op, payload=b""):
        msg = struct.pack("<II", obj, ((8 + len(payload)) << 16) | op) + payload
        try:
            with self.slock:
                self.sock.sendall(msg)
        except OSError:
            self.ok = False

    def _bind(self, reg, name, iface, ver):
        nid = self._new(iface)
        self._send(reg, 0, struct.pack("<I", name) + _str(iface) + struct.pack("<II", ver, nid))
        return nid

    def _loop(self):
        buf = b""
        while True:
            try:
                data = self.sock.recv(65536)
            except OSError:
                data = b""
            if not data:
                self.ok = False
                return
            buf += data
            while len(buf) >= 8:
                obj, so = struct.unpack_from("<II", buf)
                size, op = so >> 16, so & 0xFFFF
                if size < 8 or len(buf) < size:
                    break
                body, buf = buf[8:size], buf[size:]
                try:
                    self._event(obj, op, body)
                except Exception:
                    pass

    def _event(self, obj, op, b):
        iface = self.ifaces.get(obj)
        if iface == "wl_registry" and op == 0:                       # global
            name, o = _u32(b, 0)
            itf, o = _s(b, o)
            ver, _ = _u32(b, o)
            if itf == "wl_seat" and not self.seat:
                self.seat = self._bind(obj, name, itf, 1)
            elif itf == "zwlr_foreign_toplevel_manager_v1" and not self.mgr:
                self.mgr = self._bind(obj, name, itf, min(ver, 3))
                self.ok = True
        elif iface == "zwlr_foreign_toplevel_manager_v1" and op == 0:  # nova janela
            hid, _ = _u32(b, 0)
            self.ifaces[hid] = "handle"
            self.pending[hid] = {}
        elif iface == "handle":
            self._handle(obj, op, b)

    def _handle(self, hid, op, b):
        p = self.pending.setdefault(hid, {})
        if op == 0:
            p["title"] = _s(b, 0)[0]
        elif op == 1:
            p["app_id"] = _s(b, 0)[0]
        elif op == 4:
            arr, _ = _arr(b, 0)
            st = set(struct.unpack("<%dI" % (len(arr) // 4), arr[: len(arr) // 4 * 4]))
            p.update(max=_ST_MAX in st, min=_ST_MIN in st, active=_ST_ACTIVE in st, full=_ST_FULL in st)
        elif op == 5:                                                  # done
            with self.dlock:
                w = self.wins.get(hid)
                if w is None:
                    w = self.wins[hid] = {"id": hid, "title": "", "app_id": "", "max": False, "min": False,
                                          "active": False, "full": False, "order": 0, "born": time.time()}
                was = w["active"]
                w.update(p)
                p.clear()
                if w["active"] and not was:
                    self.tick += 1
                    w["order"] = self.tick
                self.seq += 1
                intruder = self.guard and w["active"] and not w["min"] and w["app_id"] != self.shell_id
            if intruder:                       # bloqueado: esconde o app e volta para a tela de bloqueio
                self.minimize(hid)
                self.raise_shell()
            self.on_change()
        elif op == 6:                                                  # closed
            with self.dlock:
                self.wins.pop(hid, None)
                self.pending.pop(hid, None)
                self.seq += 1
            self._send(hid, 7)                                         # destroy
            self.ifaces.pop(hid, None)
            self.on_change()

    # ------------------------------------------------------------ consultas
    def shell(self):
        return next((w for w in list(self.wins.values()) if w["app_id"] == self.shell_id), None)

    def natives(self):
        return sorted((w for w in list(self.wins.values()) if w["app_id"] != self.shell_id),
                      key=lambda w: w["born"])

    def above_shell(self):
        """Apps visíveis que estão por cima da interface, de baixo para cima."""
        return [w["id"] for w in sorted(self.natives(), key=lambda w: w["order"])
                if not w["min"] and w["order"] > self.shell_raised]

    def snapshot(self):
        s = self.shell()
        return {"available": self.ok, "seq": self.seq,
                "shell_active": bool(s and s["active"]),
                "above": self.above_shell(),
                "windows": [{k: w[k] for k in ("id", "title", "app_id", "max", "min", "active", "full")}
                            for w in self.natives()]}

    # ------------------------------------------------------------ ações
    def activate(self, hid):
        w = self.wins.get(hid)
        if not w or not self.seat:
            return False
        if w["min"]:
            self._send(hid, 3)                                         # unset_minimized
        self._send(hid, 4, struct.pack("<I", self.seat))               # activate
        return True

    def minimize(self, hid):
        self._send(hid, 2)

    def close(self, hid):
        self._send(hid, 5)

    def maximize(self, hid, on=True):
        self._send(hid, 0 if on else 1)

    def toggle(self, hid):
        """Clique na barra de tarefas: minimiza se já está na frente, senão traz para frente."""
        w = self.wins.get(hid)
        if not w:
            return False
        top = self.above_shell()
        if w["active"] and not w["min"] and top and top[-1] == hid:
            self.minimize(hid)
        else:
            self.activate(hid)
        return True

    def raise_shell(self, temp=False):
        s = self.shell()
        if not s:
            return False
        above = self.above_shell()
        if not above and s["active"]:
            return True                                                # já está na frente
        if temp:
            self.saved = above
        self.tick += 1
        self.shell_raised = self.tick
        self.activate(s["id"])
        return True

    def restore(self):
        saved, self.saved = self.saved, []
        for hid in saved:
            w = self.wins.get(hid)
            if w and not w["min"]:
                self.activate(hid)
        return True

    def toggle_desktop(self):
        vis = [w for w in sorted(self.natives(), key=lambda w: w["order"]) if not w["min"]]
        if vis:
            self.desk_hidden = [w["id"] for w in vis]
            for w in vis:
                self.minimize(w["id"])
        else:
            for hid in self.desk_hidden:
                if hid in self.wins:
                    self.activate(hid)
            self.desk_hidden = []
        return True

    def hide_all(self):
        for w in self.natives():
            if not w["min"]:
                self.minimize(w["id"])
