#!/bin/bash
# Sobe o backend do NeonOS e mantém a interface aberta no Firefox.

python3 /opt/neonos/server.py >/tmp/neonos-server.log 2>&1 &
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

# se o Firefox da interface fechar, abre de novo
while true; do
  firefox-esr --no-remote --name neonos-shell --profile "$prof" http://localhost:8080/
  sleep 1
done
