#!/usr/bin/env bash
# Gera out/neonos-amd64.iso usando Docker (funciona em macOS, Linux ou Windows/WSL).
set -euo pipefail
cd "$(dirname "$0")"
inc=config/includes.chroot

# bibliotecas do terminal (xterm.js), para funcionar sem internet
mkdir -p ../neonos/vendor
[ -f ../neonos/vendor/xterm.js ] || curl -fsSL -o ../neonos/vendor/xterm.js https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js
[ -f ../neonos/vendor/xterm.css ] || curl -fsSL -o ../neonos/vendor/xterm.css https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css
[ -f ../neonos/vendor/xterm-addon-fit.js ] || curl -fsSL -o ../neonos/vendor/xterm-addon-fit.js https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js

# interface + backend em /opt/neonos, comandos em /usr/local/bin
rm -rf "$inc/opt/neonos"
mkdir -p "$inc/opt/neonos" "$inc/usr/local/bin" out
cp -r ../neonos/. "$inc/opt/neonos/"
rm -rf "$inc/opt/neonos/__pycache__"
cp ../neonos/neon-browser.sh "$inc/usr/local/bin/neon-browser"
cp ../neonos/neon-notify "$inc/usr/local/bin/neon-notify"
cp ../neonos/neon "$inc/usr/local/bin/neon"
cp ../neonos/neon-update "$inc/usr/local/bin/neon-update"
cp ../neonos/neon-display "$inc/usr/local/bin/neon-display"
chmod +x auto/config config/hooks/normal/*.hook.chroot "$inc/usr/local/bin/"* "$inc/opt/neonos/"*.sh \
         "$inc/etc/skel/.config/labwc/neonos-start.sh"

docker build --platform linux/amd64 -t neonos-builder .
docker run --rm --privileged --platform linux/amd64 \
  -v "$PWD":/src:ro -v "$PWD/out":/out neonos-builder bash -euc '
    cp -a /src/auto /src/config /build/
    cd /build
    lb config
    lb build
    cp -v ./*.iso /out/neonos-amd64.iso
  '
echo "Pronto: $PWD/out/neonos-amd64.iso"
