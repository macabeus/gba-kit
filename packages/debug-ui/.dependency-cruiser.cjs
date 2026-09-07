/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-debug-adapter',
      comment:
        'The panels run in browsers. The request vocabulary they need is @gba-kit/debug-core/protocol; ' +
        '@gba-kit/debug-adapter is the Node DAP server, one host of that vocabulary, and must never be bundled here.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '@gba-kit/debug-adapter' },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
  },
};
