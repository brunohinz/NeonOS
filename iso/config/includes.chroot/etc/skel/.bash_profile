# NeonOS: no tty1, inicia o compositor labwc (que abre a interface NeonOS).
# Ctrl+Alt+F2 abre um bash de texto normal.
[ -f ~/.bashrc ] && . ~/.bashrc

if [ -z "$WAYLAND_DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
  exec labwc
fi
