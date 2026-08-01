#!/usr/bin/env bash
# Rebuild this project's committed artifacts (build/main.o, build/min.elf and their
# oracles) in Docker, so a contributor needs only Docker — no local
# powerpc-linux-gnu install. Run this after changing the sources, then commit the
# refreshed build/ artifacts. (Normal test runs use the committed files and need
# none of this.)
#
# The toolchain is the stock Ubuntu cross package, the same one CI installs
# natively; --platform linux/amd64 keeps the image identical on an arm64 host.
set -euo pipefail
cd "$(dirname "$0")"
docker run --rm --platform linux/amd64 -v "$PWD/..":/test-projects -w /test-projects/ppc-min ubuntu:24.04 bash -lc '
  apt-get update -qq && apt-get install -y -qq make gcc-powerpc-linux-gnu binutils-powerpc-linux-gnu nodejs >/dev/null
  make clean && make
'
echo "Built build/main.o + build/min.elf + oracles"
