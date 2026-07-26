import { defineConfig } from 'vitest/config';

// Separate config for Tier 1 (real Docker) tests — deliberately NOT excluded
// here, unlike vitest.config.ts's default fast loop. Run via `npm run test:tier1`.
export default defineConfig({
  test: {
    include: ['src/e2e.tier1.test.ts'],
    // Real docker build/run is much slower than the mocked Tier 0 suite.
    testTimeout: 5 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
  },
});
