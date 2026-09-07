#!/usr/bin/env bash
# Rebuild the committed fixture ROMs/ELFs in Docker, so a contributor needs only
# Docker — no local devkitARM. Run after changing the sources, then commit build/.
set -euo pipefail
cd "$(dirname "$0")"
docker run --rm -v "$PWD":/fixtures -w /fixtures devkitpro/devkitarm:latest bash -lc 'make clean && make'
echo "Built build/{thumb-O0,thumb-O2,arm-O0}.{elf,gba}"
