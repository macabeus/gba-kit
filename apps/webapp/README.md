# @gba-kit/webapp

Browser-based GBA debugger with real-time emulation, disassembly, breakpoints, memory inspection, and save states. It runs entirely client-side, with optional support for a dev server.

## Features

- GBA emulation
- Debugger panel with ARM/Thumb disassembly, execution control, CPU register viewer, memory viewer, etc
- Save state slots, persisted in IndexedDB
- Input recording and script replay

## Usage

### Standalone (no ROM server)

Build and open `dist/index.html`:

```bash
pnpm build
open dist/index.html
```

### With Dev Server

Run the dev server with hot reload and optional ROM auto-loading:

```bash
# Minimal — ROM loaded via file picker in browser
pnpm dev

# With ROM auto-loading
pnpm dev -- --rom ./game.gba
```

The dev server starts:

- **UI** on `http://localhost:5174/` (Vite with HMR)
- **API** on `http://localhost:3001/` (proxied via `/api/`)

### API Endpoints

| Endpoint       | Method | Description                    |
| -------------- | ------ | ------------------------------ |
| `/api/loadRom` | GET    | Serves the configured ROM file |

## Build

Produces a single self-contained `index.html` via `vite-plugin-singlefile`:

```bash
pnpm build
# Output: dist/index.html
```

## Keyboard Controls

| Key         | GBA Button |
| ----------- | ---------- |
| Arrow keys  | D-pad      |
| `z`         | A          |
| `x`         | B          |
| `Enter`     | Start      |
| `Backspace` | Select     |
| `a`         | R          |
| `s`         | L          |
