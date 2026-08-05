#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  apktool \
  binutils \
  binwalk \
  build-essential \
  bzip2 \
  ca-certificates \
  checksec \
  curl \
  default-jre \
  dnsutils \
  ffmpeg \
  file \
  foremost \
  gdb \
  git \
  gzip \
  hashcat \
  imagemagick \
  john \
  jq \
  libfplll-dev \
  libgmp-dev \
  libimage-exiftool-perl \
  libmpc-dev \
  libmpfr-dev \
  libyara-dev \
  nmap \
  p7zip-full \
  pkg-config \
  python3 \
  python3-dev \
  python3-pip \
  python3-venv \
  qemu-user \
  qrencode \
  ripgrep \
  ruby \
  ruby-dev \
  sleuthkit \
  sqlite3 \
  strace \
  tar \
  testdisk \
  tshark \
  unzip \
  whois \
  xxd \
  xz-utils \
  zbar-tools \
  zstd
rm -rf /var/lib/apt/lists/*
