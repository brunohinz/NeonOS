# NeonOS: no tty1, inicia o compositor labwc (que abre a interface NeonOS).
# Ctrl+Alt+F2 abre um bash de texto normal.
[ -f ~/.bashrc ] && . ~/.bashrc

if [ -z "$WAYLAND_DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
  # placa NVIDIA com o driver proprietário: cursor desenhado por software (evita cursor invisível)
  [ -e /proc/driver/nvidia/version ] && export WLR_NO_HARDWARE_CURSORS=1
  exec labwc
fi
