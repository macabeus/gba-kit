/**
 * The debug adapter as its own process, bundled with everything it needs so the
 * packaged extension carries no node_modules. VS Code launches it with `node`
 * and speaks DAP over stdio.
 */
import { GbaDebugSession } from '@gba-kit/debug-adapter';

GbaDebugSession.run(GbaDebugSession);
