/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-play-to-debug',
      comment: 'Pages must not import from each other. Move shared code to src/components/.',
      severity: 'error',
      from: { path: '^src/pages/play/' },
      to: { path: '^src/pages/(debug|load)/' },
    },
    {
      name: 'no-debug-to-play',
      comment: 'Pages must not import from each other. Move shared code to src/components/.',
      severity: 'error',
      from: { path: '^src/pages/debug/' },
      to: { path: '^src/pages/(play|load)/' },
    },
    {
      name: 'no-load-to-others',
      comment: 'Pages must not import from each other. Move shared code to src/components/.',
      severity: 'error',
      from: { path: '^src/pages/load/' },
      to: { path: '^src/pages/(play|debug)/' },
    },
    {
      name: 'page-entry-points-only',
      comment:
        'Only the entry component of each page may be imported from outside. ' +
        'debug/DebugView, load/LoadView, play/PlayView are the only allowed entry points. ' +
        'Unit tests are exempt — they may import a page-internal module directly.',
      severity: 'error',
      from: { pathNot: ['^src/pages/', '^src/__tests__/'] },
      to: {
        path: '^src/pages/',
        pathNot: '^src/pages/(debug/DebugView|load/LoadView|play/PlayView)\\.',
      },
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
