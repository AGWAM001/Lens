import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // forks: each concurrent file gets its own process. This pins Vitest's
    // existing default rather than changing it - the flake was env leakage
    // within a reused fork, which setupFiles settles.
    pool: 'forks',
    setupFiles: ['./vitest.setup.ts'],
    // resetModules()+@stellar/stellar-sdk reimport (networkVenueConfig) needs
    // a little headroom over the 5s default. Kept deliberately tight: a loose
    // ceiling hides a genuine hang as a slow pass.
    testTimeout: 20_000,
  },
})
