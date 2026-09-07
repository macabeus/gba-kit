import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/__tests__/**/*.spec.{ts,tsx}'],
  },
});
