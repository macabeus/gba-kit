#!/usr/bin/env node
/**
 * Pre-publish guard: ensures @gba-kit packages are only published
 * from the correct NPM account ("macabeus").
 */
import { execSync } from 'node:child_process';

const EXPECTED_USER = 'macabeus';

let user;
try {
  user = execSync('npm whoami', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
} catch {
  console.error('\x1b[31m');
  console.error('ERROR: Not logged in to NPM.');
  console.error('');
  console.error('Set your personal access token:');
  console.error('  export NPM_TOKEN=<your-token>');
  console.error('');
  console.error('Or log in:');
  console.error('  npm login');
  console.error('\x1b[0m');
  process.exit(1);
}

if (user !== EXPECTED_USER) {
  console.error('\x1b[31m');
  console.error(`ERROR: Logged in as "${user}" — must be "${EXPECTED_USER}".`);
  console.error('');
  console.error('@gba-kit packages must be published from the personal account.');
  console.error('Set your personal access token:');
  console.error('  export NPM_TOKEN=<your-token>');
  console.error('\x1b[0m');
  process.exit(1);
}

console.log(`\x1b[32mNPM account verified: ${user}\x1b[0m`);
