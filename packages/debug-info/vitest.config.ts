import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.spec.ts'],
    // Ensure the vendored GBA test-project ELFs are present before tests run (see
    // vitest.globalSetup.ts).
    globalSetup: ['./vitest.globalSetup.ts'],
  },
});
