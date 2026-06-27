#!/usr/bin/env bash
# Rebuild this project's committed artifacts (build/min.elf + build/oracle.json) in
# Docker, so a contributor needs only Docker — no local devkitARM/arm-none-eabi
# install. Run this after changing the sources, then commit build/min.elf and
# build/oracle.json. (Normal test runs use the committed files and need none of this.)
#
# The devkitARM image provides arm-none-eabi gcc + binutils ($DEVKITARM is preset,
# which the Makefile picks up); node — needed by ../tools/gen-oracle.mjs for the
# oracle — isn't in the image, so install it on the fly.
set -euo pipefail
cd "$(dirname "$0")"
docker run --rm -v "$PWD/..":/test-projects -w /test-projects/devkitarm-min devkitpro/devkitarm:latest bash -lc '
  command -v node >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq nodejs >/dev/null; }
  make clean && make
'
echo "Built build/min.elf + build/oracle.json"
