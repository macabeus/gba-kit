import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.spec.ts'],
    // The owned ROM/ELF fixtures are committed; on CI they are rebuilt (see vitest.globalSetup.ts).
    globalSetup: ['./vitest.globalSetup.ts'],
  },
});
