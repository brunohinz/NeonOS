#!/bin/bash
# Sobe o backend do NeonOS e mantém a interface aberta no Firefox, cobrindo todos os monitores.

# apps nativos: portais (escolher arquivos, compartilhar tela), D-Bus e systemd sabem qual é a tela
dbus-update-activation-environment --systemd WAYLAND_DISPLAY DISPLAY XDG_CURRENT_DESKTOP XCURSOR_THEME \
  XCURSOR_SIZE QT_QPA_PLATFORMTHEME LABWC_PID 2>/dev/null || true
xdg-user-dirs-update 2>/dev/null || true

# notificações dos apps (estilo neon) e a janelinha de senha de administrador dos apps nativos
command -v mako >/dev/null && mako >/tmp/neonos-mako.log 2>&1 &
for a in /usr/libexec/polkit-mate-authentication-agent-1 /usr/lib/x86_64-linux-gnu/polkit-mate/polkit-mate-authentication-agent-1; do
  [ -x "$a" ] && { "$a" >/dev/null 2>&1 & break; }
done

python3 /opt/neonos/server.py >/tmp/neonos-server.log 2>&1 &

# monitores: reaplica o último modo escolhido no Super+P (padrão: estender)
/opt/neonos/neon-display apply >/tmp/neonos-display.log 2>&1 || true

for _ in $(seq 1 80); do
  (echo > /dev/tcp/127.0.0.1/8080) 2>/dev/null && break
  sleep 0.1
done

# perfil próprio da interface (sem barras do Firefox)
prof="$HOME/.neonos-shell"
if [ ! -f "$prof/user.js" ]; then
  mkdir -p "$prof"
  cp -r /usr/share/neonos/firefox-shell/. "$prof/"
fi

# se o Firefox da interface fechar (ou os monitores mudarem), abre de novo no tamanho certo
while true; do
  /opt/neonos/neon-display shell-rule >>/tmp/neonos-display.log 2>&1 || true
  firefox-esr --no-remote --name neonos-shell --profile "$prof" http://localhost:8080/
  sleep 1
done
