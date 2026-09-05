import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These tests boot a GBA and run frames, so a few take seconds of real work; the
    // 5s default fails them on a loaded machine or a busy CI runner, which reads as a
    // broken build rather than a slow one.
    testTimeout: 20_000,
  },
});
