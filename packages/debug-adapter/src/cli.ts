#!/usr/bin/env node
/**
 * The adapter as a process: DAP over stdin/stdout, or `--server=<port>` for a TCP
 * client. This is what any editor's DAP client launches:
 *
 *   npx @gba-kit/debug-adapter
 */
import { GbaDebugSession } from './session.js';

GbaDebugSession.run(GbaDebugSession);
