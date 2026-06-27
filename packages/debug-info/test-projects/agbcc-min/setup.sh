#!/usr/bin/env bash
# One-time setup for the agbcc minimal project: fetch + build the agbcc submodule,
# then build build/min.elf. agbcc (GCC 2.95) is built from source — needs a host
# C compiler and arm-none-eabi binutils on PATH.
set -euo pipefail
cd "$(dirname "$0")"

# Ensure the submodule is checked out (no-op if already present).
git -C "$(git rev-parse --show-toplevel)" submodule update --init -- \
  "packages/debug-info/test-projects/agbcc-min/agbcc"

# Build the compiler (produces agbcc/bin/agbcc).
( cd agbcc && ./build.sh )

# Build the minimal ELF using the freshly built compiler.
make clean
make
echo "Built build/min.elf"
