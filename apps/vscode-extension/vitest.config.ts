import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The extension and frame-server tests wait on real pipes and sockets, so the 5s
    // default fails them on a loaded machine or a busy CI runner, which reads as a broken
    // build rather than a slow one. (The bundling and packaging tests carry their own.)
    testTimeout: 20_000,
    include: ['src/__tests__/**/*.spec.ts'],
  },
});
