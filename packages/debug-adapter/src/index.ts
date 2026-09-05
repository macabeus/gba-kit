/**
 * @gba-kit/debug-adapter — a Debug Adapter Protocol server for GBA programs.
 *
 * `GbaDebugSession` speaks DAP on any pair of streams: stdio for an editor that
 * launches the adapter as a process (`dist/cli.js`), or in-process for a host that
 * prefers to embed it (VS Code's `DebugAdapterInlineImplementation`). The gba-kit
 * extensions to the protocol are described in `./protocol`.
 */
export { GbaDebugSession, type LaunchArguments } from './session.js';
export { FrameStream, StreamReader } from './stream.js';
export * from './protocol.js';
