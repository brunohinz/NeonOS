#!/bin/bash
# Cria uma partição "persistence" no espaço livre do pendrive de boot do NeonOS.
# Roda como root (chamado pelo backend via sudo).
set -euo pipefail

src=$(findmnt -no SOURCE /run/live/medium || true)
[ -n "$src" ] || { echo "Mídia live não encontrada."; exit 1; }
disk="/dev/$(lsblk -no PKNAME "$src" | head -n1)"
[ -b "$disk" ] || { echo "Disco de boot não encontrado (src=$src)."; exit 1; }

if lsblk -no LABEL "$disk" | grep -qx persistence; then
  echo "Já existe uma partição de persistência em $disk."
  exit 0
fi

echo "Pendrive de boot: $disk"
lsblk -o NAME,SIZE,LABEL,FSTYPE "$disk"
echo
echo "Criando partição no espaço livre…"
echo ',,L' | sfdisk --append --force --no-reread "$disk"
partx -u "$disk" || partx -a "$disk" || true
udevadm settle || true
sleep 1

part=$(lsblk -lnpo NAME,TYPE "$disk" | awk '$2=="part"{p=$1} END{print p}')
[ -b "$part" ] && [ "$part" != "$src" ] || { echo "Não consegui identificar a nova partição."; exit 1; }

echo "Formatando $part…"
mkfs.ext4 -F -L persistence "$part"
mnt=$(mktemp -d)
mount "$part" "$mnt"
echo "/ union" > "$mnt/persistence.conf"
umount "$mnt"
rmdir "$mnt"
echo
echo "Pronto! Reinicie o NeonOS para ativar a persistência."
