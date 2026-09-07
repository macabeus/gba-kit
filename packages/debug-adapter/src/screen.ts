#!/usr/bin/env node
/**
 * `gba-kit-screen [--port N] [--pipe PATH]`: a browser page showing the GBA
 * screen with a keyboard gamepad, for editors without one. Start it, then tell
 * the adapter where to stream with the request it prints.
 */
import { ScreenServer } from './screen-server.js';

const args = process.argv.slice(2);
let port = 4712;
let pipe: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = Number(args[++i]);
  } else if (args[i] === '--pipe' && args[i + 1]) {
    pipe = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log('usage: gba-kit-screen [--port 4712] [--pipe /path/to/pipe]');
    process.exit(0);
  }
}

const server = new ScreenServer({ pipe, port });
server
  .listen()
  .then(() => {
    console.log(`GBA screen: ${server.url}`);
    console.log(`Connect the debugger with the custom request:`);
    console.log(`  gba-kit/stream ${JSON.stringify({ path: server.pipe })}`);
    console.log(
      `(nvim-dap: :lua require('dap').session():request('gba-kit/stream', { path = ${JSON.stringify(server.pipe)} })`,
    );
  })
  .catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });

process.on('SIGINT', () => {
  void server.close().then(() => process.exit(0));
});
