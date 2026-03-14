# Contributing to gba-kit

Thanks for your interest in contributing to gba-kit! This document covers how to get set up and submit changes.

## Development Setup

1. **Prerequisites**: Node.js >= 22, pnpm

2. **Clone and install**:

   ```bash
   git clone https://github.com/macabeus/gba-kit.git
   cd gba-kit
   pnpm install
   ```

3. **Build all packages**:

   ```bash
   pnpm turbo build
   ```

4. **Start the dev server** (hot-reloads all emulator packages):

   ```bash
   pnpm dev
   ```

## Useful Commands

| Command                  | Description                                 |
| ------------------------ | ------------------------------------------- |
| `pnpm dev`               | Start the webapp dev server with hot-reload |
| `pnpm turbo build`       | Build all packages                          |
| `pnpm turbo test`        | Run all tests                               |
| `pnpm turbo check-types` | Type-check all packages                     |
| `pnpm turbo lint`        | Lint all packages                           |
| `pnpm run format`        | Format all files with Prettier              |
| `pnpm run format:check`  | Check formatting without writing            |

## Submitting Changes

1. Fork the repository and create a branch from `main`
2. Make your changes
3. Ensure all checks pass: `pnpm turbo build test check-types lint && pnpm run format:check`
4. Open a pull request against `main`

Keep pull requests focused — one feature or fix per PR.
