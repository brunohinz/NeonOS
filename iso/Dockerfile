FROM debian:trixie
RUN apt-get update && apt-get install -y --no-install-recommends \
      live-build debootstrap xorriso squashfs-tools isolinux syslinux-common \
      grub-pc-bin grub-efi-amd64-bin grub-efi-amd64-signed shim-signed mtools dosfstools \
      ca-certificates cpio zstd \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
