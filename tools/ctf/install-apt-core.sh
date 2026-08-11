#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get -o Acquire::Retries=5 update
apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
  apktool \
  bc \
  binutils \
  binwalk \
  build-essential \
  bzip2 \
  ca-certificates \
  checksec \
  curl \
  dcfldd \
  default-jre \
  dnsutils \
  dirsearch \
  ffmpeg \
  ffuf \
  file \
  foremost \
  gdb \
  gifsicle \
  gmp-ecm \
  git \
  gzip \
  gobuster \
  hashcat \
  imagemagick \
  john \
  jq \
  libfplll-dev \
  libgmp-dev \
  libimage-exiftool-perl \
  libmpc-dev \
  libmpfr-dev \
  libsox-fmt-all \
  libyara-dev \
  minimodem \
  multimon-ng \
  nmap \
  outguess \
  p7zip-full \
  pari-gp \
  pngcheck \
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
  sox \
  sqlite3 \
  steghide \
  stegsnow \
  strace \
  tar \
  tesseract-ocr \
  testdisk \
  tshark \
  unzip \
  whois \
  xfsprogs \
  xxd \
  xz-utils \
  zbar-tools \
  zip \
  zstd
rm -rf /var/lib/apt/lists/*
