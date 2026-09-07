/**
 * Standalone debug adapter over stdio — what a non-VS Code editor launches.
 *
 *   node dist/adapter-cli.js
 *
 * nvim-dap example:
 *   dap.adapters['gba-kit'] = { type = 'executable', command = 'node', args = { '/path/dist/adapter-cli.js' } }
 *   dap.configurations.c = { { type = 'gba-kit', request = 'launch', name = 'GBA', rom = 'build/game.gba', elf = 'build/game.elf' } }
 *
 * Without a screen client the game still runs headless; the frame stream is only
 * consumed by the VS Code webview today.
 */
import { GbaDebugSession } from './session.js';

GbaDebugSession.run(GbaDebugSession);
