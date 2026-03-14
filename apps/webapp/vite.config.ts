import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const packagesDir = path.resolve(__dirname, '../../packages');

export default defineConfig(({ command }) => ({
  plugins: [react(), ...(command === 'build' ? [viteSingleFile()] : [])],
  root: __dirname,
  resolve:
    command === 'serve'
      ? {
          alias: {
            '@gba-kit/arm-emulator/arm-cpu': path.join(packagesDir, 'arm-emulator/src/arm-cpu.ts'),
            '@gba-kit/arm-emulator/disassembler': path.join(packagesDir, 'arm-emulator/src/disassembler.ts'),
            '@gba-kit/arm-emulator': path.join(packagesDir, 'arm-emulator/src/index.ts'),
            '@gba-kit/gba-emulator/savestate': path.join(packagesDir, 'gba-emulator/src/savestate.ts'),
            '@gba-kit/gba-emulator': path.join(packagesDir, 'gba-emulator/src/index.ts'),
            '@gba-kit/gba-browser': path.join(packagesDir, 'gba-browser/src/index.ts'),
            '@gba-kit/gba-react': path.join(packagesDir, 'gba-react/src/index.ts'),
          },
        }
      : undefined,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
  },
  server: {
    port: 5174,
    proxy: {
      '/api/': 'http://localhost:3001',
    },
  },
}));
