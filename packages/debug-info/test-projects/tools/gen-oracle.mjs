#!/usr/bin/env node
// Generates the test oracle for one built ELF: the symbol→address map (from `nm`)
// and the {func,file,line} for every function entry (from `addr2line`). Each test
// project's Makefile runs this and writes the result to build/oracle.json, which
// src/__tests__/real-projects.spec.ts then reads.
//
// Keeping the binutils calls here (rather than in the test) makes the test pure
// data-in/data-out, and pairs the oracle with the exact ELF + toolchain that built
// it. The oracle dumps ALL symbols and ALL function entries, so adding a probe to
// the test needs no change here.
//
// File paths are reduced to their basename so the committed oracle.json is
// machine-independent (DWARF embeds the builder's absolute comp_dir).
//
// Usage: node gen-oracle.mjs <elf> [binutils-prefix]   (prefix defaults to arm-none-eabi-)
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const [elf, prefix = 'arm-none-eabi-'] = process.argv.slice(2);
if (!elf) {
  console.error('usage: gen-oracle.mjs <elf> [binutils-prefix]');
  process.exit(1);
}

const run = (tool, args) => execFileSync(`${prefix}${tool}`, args, { encoding: 'utf8' });

// Every symbol: name -> { addr, kind } (kind = the nm type letter; T/t = function).
const entries = [];
for (const line of run('nm', [elf]).split('\n')) {
  const m = line.match(/^([0-9a-fA-F]+)\s+(\S)\s+(\S+)$/);
  if (m) {
    entries.push({ name: m[3], addr: parseInt(m[1], 16), kind: m[2] });
  }
}

const symbols = {};
for (const { name, addr } of entries) {
  symbols[name] = addr;
}

// Function entries -> addr2line's reference {func, file, line}.
const lines = {};
for (const { addr, kind } of entries) {
  if (kind !== 'T' && kind !== 't') {
    continue;
  }
  const [func, where] = run('addr2line', ['-f', '-e', elf, '0x' + addr.toString(16)])
    .trim()
    .split('\n');
  const i = where.lastIndexOf(':');
  lines['0x' + addr.toString(16)] = { func, file: basename(where.slice(0, i)), line: Number(where.slice(i + 1)) };
}

process.stdout.write(JSON.stringify({ symbols, lines }, null, 2) + '\n');
