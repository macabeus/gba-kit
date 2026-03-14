/**
 * GBA Node.js Package — Public API
 *
 * Headless GBA emulator runtime for Node.js scripting.
 */
export { HeadlessRuntime } from './headless-runtime.js';
export type { HeadlessRuntimeOptions } from './headless-runtime.js';
export { NodeScriptingHost } from './node-scripting-host.js';
export { serializeSnapshot, deserializeSnapshot } from './snapshot-serializer.js';
