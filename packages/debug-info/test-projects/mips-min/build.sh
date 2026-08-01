#!/usr/bin/env bash
# Rebuild this project's committed artifacts (build/min.elf + build/oracle.json) in
# Docker, so a contributor needs only Docker — no local mips-linux-gnu install. Run
# this after changing the sources, then commit build/min.elf and build/oracle.json.
# (Normal test runs use the committed files and need none of this.)
#
# The toolchain is the stock Ubuntu cross package, the same one CI installs
# natively; --platform linux/amd64 keeps the image identical on an arm64 host.
set -euo pipefail
cd "$(dirname "$0")"
docker run --rm --platform linux/amd64 -v "$PWD/..":/test-projects -w /test-projects/mips-min ubuntu:24.04 bash -lc '
  apt-get update -qq && apt-get install -y -qq make gcc-mips-linux-gnu binutils-mips-linux-gnu nodejs >/dev/null
  make clean && make
'
echo "Built build/min.elf + build/oracle.json"
