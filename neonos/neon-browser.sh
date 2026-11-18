#!/bin/bash
# Abre o navegador do NeonOS (Firefox, perfil próprio) ou traz a janela para frente.
prof="$HOME/.neonos-browser"
mkdir -p "$prof"

if [ -z "${1:-}" ] && wlrctl toplevel find app_id:neonos-browser 2>/dev/null; then
  exec wlrctl toplevel focus app_id:neonos-browser
fi

firefox-esr --name neonos-browser --profile "$prof" "${1:-about:home}" &
sleep 0.6
wlrctl toplevel focus app_id:neonos-browser 2>/dev/null || true
