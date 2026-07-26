import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
    // Tier 1 spins up a real Docker daemon and builds/runs the real agent
    // image — far too slow (and Linux-only) for the default fast loop.
    // Run it explicitly via `npm run test:tier1`.
    exclude: ['**/node_modules/**', 'src/**/*.tier1.test.ts'],
  },
});
